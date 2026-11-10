import { z } from "zod";
import { mailClaimResultSchema } from "./model";

/** Replay describes this request, not the gift saved in the mailbox. */
export const mailClaimReceiptSchema = mailClaimResultSchema.extend({ replayed: z.boolean().optional() });
export type MailClaimReceipt = z.infer<typeof mailClaimReceiptSchema>;
