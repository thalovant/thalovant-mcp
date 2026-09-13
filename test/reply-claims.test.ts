import assert from "node:assert/strict";
import { test } from "vitest";
import { readFileSync } from "node:fs";
import { ThalovantEvent, type ThalovantReply, type EventContext } from "@thalovant/sdk";
import { runtimeReplyContent } from "../src/reply-output.js";
const data = JSON.parse(readFileSync(new URL("./reply-claim-vectors.json", import.meta.url), "utf8"));
for (const row of data.cases) test(`MCP reply claim: ${row.name}`, () => {
    const reply: ThalovantReply = { text:"reply", displayText:"reply", utterances:[], handled:row.handled, ok:row.handled && !row.failed,
        events:row.contexts.map((context:EventContext) => new ThalovantEvent("speak", {}, context)),
        failureEvent:row.failed ? new ThalovantEvent("failure") : undefined, displayItems:() => [] };
    const summary = runtimeReplyContent(reply).summary;
    assert.deepEqual(summary.pipelineIds, row.expected.pipeline_ids);
    assert.deepEqual(summary.skillIds, row.expected.skill_ids);
    assert.equal(summary.claimed, row.expected.claimed);
});
