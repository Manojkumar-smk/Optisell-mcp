#!/usr/bin/env node
// Post-build step: copy seed/*.csv into gen/srv/seed so the deployed app can run
// seedIfEmpty() / POST /admin/reset_demo_data. The CSVs are NOT in gen/db, so the
// HDI deployer never loads or overwrites table data on deploy.
const fs = require('fs'), path = require('path')
const root = path.join(__dirname, '..')
const from = path.join(root, 'seed'), to = path.join(root, 'gen', 'srv', 'seed')
if (!fs.existsSync(path.join(root, 'gen', 'srv'))) { console.error('gen/srv not found — run `npx cds build --production` first'); process.exit(1) }
fs.rmSync(to, { recursive: true, force: true })
fs.cpSync(from, to, { recursive: true })
const n = fs.readdirSync(to).filter(f => f.endsWith('.csv')).length
if (n !== 10) { console.error(`expected 10 seed CSVs, copied ${n}`); process.exit(1) }
console.log(`copied ${n} seed CSVs → gen/srv/seed`)
