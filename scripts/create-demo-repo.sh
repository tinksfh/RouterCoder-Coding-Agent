#!/usr/bin/env bash
set -euo pipefail

demo_dir="$(mktemp -d /tmp/routercoder-demo-XXXXXX)"
mkdir -p "$demo_dir/src" "$demo_dir/test"
cat > "$demo_dir/src/math.js" <<'EOF'
export function add(a, b) {
  return a - b;
}
EOF
cat > "$demo_dir/test/math.test.js" <<'EOF'
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { add } from '../src/math.js';

test('adds two numbers', () => {
  assert.equal(add(1, 2), 3);
});
EOF
cat > "$demo_dir/package.json" <<'EOF'
{"name":"routercoder-demo","private":true,"type":"module","scripts":{"test":"node --test"}}
EOF
git -C "$demo_dir" init -q
git -C "$demo_dir" add .
git -C "$demo_dir" -c user.name=RouterCoder -c user.email=demo@localhost commit -qm 'Add failing addition fixture'
printf '%s\n' "$demo_dir"
