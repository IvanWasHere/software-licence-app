#!/usr/bin/env node
/**
 * License API load test (licence plan M8): `POST /licenses/validate` at a
 * constant arrival rate, and the latency it was answered with.
 *
 * Open-loop on purpose. A closed loop ("N workers, each sends when the last
 * answer came back") slows down with the server and hides exactly the queueing
 * this is looking for. Here a request leaves every 1/rate seconds whatever the
 * server is doing, and its latency is measured from when it was *due*.
 *
 *   node ace licensing:load-fixture --licenses=500
 *   node scripts/load/validate.mjs --url=http://localhost:3333/api/v1 --rate=200 --duration=60
 *
 * Target: p95 under 50 ms at 200 rps on one node. Exits 1 when it misses.
 * Zero dependencies — Node 20+, plain `node:http` with keep-alive.
 */
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import http from 'node:http'
import https from 'node:https'

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [name, value] = arg.replace(/^--/, '').split('=')
    return [name, value ?? 'true']
  })
)

const url = (args.url ?? 'http://localhost:3333/api/v1').replace(/\/$/, '')
const rate = Number(args.rate ?? 200)
const duration = Number(args.duration ?? 30)
const warmup = Number(args.warmup ?? 5)
const target = Number(args.p95 ?? 50)
const fixture = JSON.parse(await readFile(args.fixture ?? 'tmp/load-fixture.json', 'utf8'))

const endpoint = new URL(`${url}/licenses/validate`)
const transport = endpoint.protocol === 'https:' ? https : http
const agent = new transport.Agent({ keepAlive: true, maxSockets: Number(args.connections ?? 64) })

/**
 * One POST on a kept-alive connection; resolves with the status once the
 * whole body has arrived.
 */
function post(body) {
  return new Promise((resolve, reject) => {
    const request = transport.request(
      endpoint,
      { method: 'POST', agent, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
      (response) => {
        response.resume()
        response.on('end', () => resolve(response.statusCode))
        response.on('error', reject)
      }
    )
    request.on('error', reject)
    request.end(body)
  })
}

const latencies = []
const statuses = new Map()
let errors = 0
let inFlight = 0
let peakInFlight = 0

async function one(index, dueAt, record) {
  const license = fixture.licenses[index % fixture.licenses.length]
  inFlight++
  peakInFlight = Math.max(peakInFlight, inFlight)

  try {
    const status = await post(
      JSON.stringify({
        product: fixture.product,
        license_key: license.key,
        instance_id: license.instance_id,
        nonce: randomUUID().replaceAll('-', ''),
      })
    )

    if (record) {
      latencies.push(performance.now() - dueAt)
      statuses.set(status, (statuses.get(status) ?? 0) + 1)
    }
  } catch {
    if (record) errors++
  } finally {
    inFlight--
  }
}

async function run(seconds, record) {
  const total = Math.round(seconds * rate)
  const start = performance.now()
  const pending = []

  for (let i = 0; i < total; i++) {
    const dueAt = start + (i * 1000) / rate
    const wait = dueAt - performance.now()
    if (wait > 1) await new Promise((resolve) => setTimeout(resolve, wait))
    pending.push(one(i, dueAt, record))
  }

  await Promise.all(pending)
  return (performance.now() - start) / 1000
}

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]

console.log(`warming up for ${warmup}s…`)
await run(warmup, false)

console.log(`${rate} rps for ${duration}s against ${url} (${fixture.licenses.length} keys)…`)
const elapsed = await run(duration, true)

latencies.sort((a, b) => a - b)
const report = {
  requests: latencies.length + errors,
  achieved_rps: Number(((latencies.length + errors) / elapsed).toFixed(1)),
  statuses: Object.fromEntries(statuses),
  errors,
  peak_in_flight: peakInFlight,
  ms: {
    p50: Number(percentile(latencies, 50).toFixed(1)),
    p95: Number(percentile(latencies, 95).toFixed(1)),
    p99: Number(percentile(latencies, 99).toFixed(1)),
    max: Number(latencies[latencies.length - 1].toFixed(1)),
  },
}

console.log(JSON.stringify(report, null, 2))

const ok = report.ms.p95 < target && errors === 0 && (statuses.get(200) ?? 0) === latencies.length
console.log(ok ? `✔ p95 ${report.ms.p95} ms < ${target} ms` : `✖ missed: p95 ${report.ms.p95} ms (target ${target} ms), non-200s or errors above`)
process.exit(ok ? 0 : 1)
