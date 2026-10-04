import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelProgress } from '../extension/src/core/model-progress.js';

test('model progress weights interleaved downloads by bytes and never regresses', () => {
  const seen = [], progress = createModelProgress((p) => seen.push(p));
  progress({ status: 'progress', file: 'encoder.onnx', total: 900, loaded: 450 });
  progress({ status: 'progress', file: 'decoder.onnx', total: 100, loaded: 0 });
  progress({ status: 'progress', file: 'decoder.onnx', total: 100, loaded: 100 });
  progress({ status: 'progress', file: 'encoder.onnx', total: 900, loaded: 800 });
  progress({ status: 'progress', file: 'encoder.onnx', total: 900, loaded: 900 });
  progress({ status: 'done', file: 'encoder.onnx' });
  progress({ status: 'done', file: 'decoder.onnx' });
  progress({ status: 'ready' });
  assert.deepEqual(seen, [50, 55, 90, 99, 100]);
});

test('model progress handles cache-only ready and separate model namespaces', () => {
  const seen = [], progress = createModelProgress((p) => seen.push(p));
  progress({ status: 'done', file: 'config.json' });
  progress({ status: 'progress', name: 'model-a', file: 'model.onnx', total: 100, progress: 20 });
  progress({ status: 'progress', name: 'model-b', file: 'model.onnx', total: 100, progress: 100 });
  progress({ status: 'ready' });
  progress({ status: 'ready' });
  assert.deepEqual(seen, [20, 60, 100]);
  const cached = [];
  createModelProgress((p) => cached.push(p))({ status: 'ready' });
  assert.deepEqual(cached, [100]);
});
