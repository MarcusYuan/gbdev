import assert from 'node:assert/strict';
import { after } from 'node:test';
import { notifyFetchSentinelCalls } from '../../src/notify/http.js';
after(() => assert.equal(notifyFetchSentinelCalls(), 0, 'AC-29: default suite fetch sentinel was never called'));
