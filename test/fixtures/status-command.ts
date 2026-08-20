import { appendFileSync } from "node:fs";

import { collectStatus } from "../../src/status.ts";

const counter = process.env.ROUTINES_TEST_STATUS_COUNTER;
if (counter) appendFileSync(counter, "collect\n");
const delayMs = Number(process.env.ROUTINES_TEST_STATUS_DELAY_MS ?? 0);
if (delayMs > 0) await Bun.sleep(delayMs);
console.log(JSON.stringify(collectStatus()));
