import { QuestionLedger } from "./questionLedger";

/** Pure shared ledger. Importing it grants no extension runtime capability and
 * performs no discovery, messaging or content-script ownership claim. */
export const questionLedger = new QuestionLedger();
