import type { FastifyInstance } from 'fastify';

import {
  createGoalHandler,
  InvalidCommandPayloadError,
  parseCreateGoalPayload,
} from '../goals/commands.ts';
import {
  createQuestTemplateHandler,
  materializeOccurrenceHandler,
  parseCreateQuestTemplate,
  parseMaterializeOccurrence,
  parseQuestTransition,
  questTransitionHandler,
  QuestNotFoundError,
  VersionConflictError,
} from '../quests/commands.ts';
import { InvalidTransitionError } from '../quests/state.ts';
import { executeCommand, PayloadMismatchError, type CommandHandler } from '../../shared/commands/bus.ts';
import { commandEnvelopeSchema, type CommandEnvelope } from '../../shared/commands/envelope.ts';
import type { Database } from '../../shared/db/pool.ts';

/**
 * Приём команд от клиента.
 *
 * Пользователь берётся из access-токена, а не из тела запроса: в конверте нет
 * поля пользователя, и схема закрыта для посторонних полей, поэтому подставить
 * чужой идентификатор нечем. Это не удобство, а граница доверия — клиент
 * недоверенный вход (docs/09, раздел 1).
 */

type HandlerFactory = (payload: Record<string, unknown>) => CommandHandler;

/**
 * Реестр известных команд. Неизвестный kind отклоняется, а не выполняется
 * «как-нибудь»: список допустимого задаётся здесь, а не приходит от клиента.
 */
const COMMANDS: Record<string, HandlerFactory> = {
  create_goal: (payload) => createGoalHandler(parseCreateGoalPayload(payload)),
  create_quest_template: (payload) =>
    createQuestTemplateHandler(parseCreateQuestTemplate(payload)),
  materialize_occurrence: (payload) =>
    materializeOccurrenceHandler(parseMaterializeOccurrence(payload)),
  start_quest: (payload) => questTransitionHandler('start_quest', parseQuestTransition(payload)),
  complete_quest: (payload) =>
    questTransitionHandler('complete_quest', parseQuestTransition(payload)),
  record_partial: (payload) =>
    questTransitionHandler('record_partial', parseQuestTransition(payload)),
  cancel_quest: (payload) => questTransitionHandler('cancel_quest', parseQuestTransition(payload)),
};

export function registerCommandRoutes(app: FastifyInstance, database: Database): void {
  app.post(
    '/commands',
    { schema: { body: commandEnvelopeSchema } },
    async (request, reply) => {
      const userId = request.userId;
      if (userId === undefined) {
        return reply.code(401).send({ error: 'unauthorized' });
      }

      const envelope = request.body as CommandEnvelope;
      const factory = COMMANDS[envelope.kind];
      if (factory === undefined) {
        return reply.code(400).send({ error: 'unknown_command_kind' });
      }

      let handler: CommandHandler;
      try {
        handler = factory(envelope.payload);
      } catch (error) {
        if (error instanceof InvalidCommandPayloadError) {
          return reply.code(400).send({ error: 'invalid_payload', detail: error.message });
        }
        throw error;
      }

      try {
        const receipt = await executeCommand(
          database,
          {
            userId,
            commandId: envelope.command_id,
            kind: envelope.kind,
            payload: envelope.payload,
          },
          handler,
        );

        return reply.send({
          command_id: envelope.command_id,
          committed_seq: receipt.committedSeq,
          duplicate: receipt.duplicate,
          result: receipt.result,
        });
      } catch (error) {
        if (error instanceof PayloadMismatchError) {
          // 409, а не 400: запрос сам по себе корректен, конфликтует он с уже
          // зафиксированным состоянием.
          return reply.code(409).send({ error: 'command_id_reused' });
        }
        if (error instanceof VersionConflictError) {
          // Клиент решал по устаревшему экрану: состояние уже другое.
          return reply.code(409).send({ error: 'version_conflict' });
        }
        if (error instanceof InvalidTransitionError) {
          // Повторное завершение приходит сюда: второй награды за одно
          // действие быть не должно.
          return reply.code(409).send({ error: 'invalid_transition' });
        }
        if (error instanceof QuestNotFoundError) {
          return reply.code(404).send({ error: 'not_found' });
        }
        // 23505 — нарушение уникальности. Запрос корректен, конфликтует он с
        // уже существующей строкой: два экземпляра на один день дали бы две
        // награды за одну задачу. Без этой ветки клиент видит 500 и считает
        // ошибку сервера своей виной.
        if ((error as { code?: string }).code === '23505') {
          return reply.code(409).send({ error: 'already_exists' });
        }
        throw error;
      }
    },
  );
}
