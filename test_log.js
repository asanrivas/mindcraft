import * as skills from './src/agent/library/skills.js';

const mockBot = { output: "" };
try {
    skills.log(mockBot, "Testing log function");
    console.log("Log success:", mockBot.output);
} catch (e) {
    console.error("Log failed:", e);
}
