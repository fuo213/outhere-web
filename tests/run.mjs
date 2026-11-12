#!/usr/bin/env node
// Unit tests for the pure modules (line-model.js, line-edit.js, elevation.js).
// No dependencies, no build:   node tests/run.mjs
import { done } from "./helpers.mjs";
import "./line-model.test.mjs";
import "./line-edit.test.mjs";
import "./line-delete.test.mjs";
import "./elevation.test.mjs";

const { passed, failed } = await done();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
