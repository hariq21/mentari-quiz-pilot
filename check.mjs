// Regresi: posttest terhalang forum -> lewati, tapi matkul dicoba lagi di putaran akhir.
import { readFileSync } from "node:fs";
import assert from "node:assert";

const src = readFileSync(new URL("./content.js", import.meta.url), "utf8");
const loop = src.slice(src.indexOf("async function runPendingQuizzes"), src.indexOf("async function ensureCourseList"));
const scan = src.slice(src.indexOf("async function findNextPendingQuiz"), src.indexOf("function detectActivityType"));

assert.ok(/if \(type === "Posttest" && forumPending\) \{[\s\S]{0,60}blocked = true/.test(scan), "posttest tidak lagi ditandai terhalang forum");
assert.ok(/return blocked \? \{ blocked: true \} : null/.test(scan), "hasil scan tidak membawa info blocked");
assert.ok(/if \(target\.blocked\) \{[\s\S]{0,80}courseIndex \+= 1/.test(loop), "matkul terhalang tidak dilewati");
assert.ok(/retryStart/.test(loop), "tidak ada putaran ulang untuk posttest yang tertunda");
assert.ok(/!\(await openCourse\(runId, courseName\)\)/.test(loop), "matkul tidak dibuka ulang setelah submit");

console.log("ok: forum pending menahan posttest, posttest dicoba lagi setelahnya");
