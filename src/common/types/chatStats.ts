import type z from "zod";
import type { ChatStatsSchema, TokenConsumerSchema } from "../orpc/schemas";

export type TokenConsumer = z.infer<typeof TokenConsumerSchema>;

export type ChatStats = z.infer<typeof ChatStatsSchema>;
