/**
 * node scripts/mobile-load-test.js ^
  --url https://your-domain.com ^
  --clients 300 ^
  --rampPerSec 30 ^
  --durationSec 300 ^
  --intervalMs 200 ^
  --kbPerSecPerClient 8 ^
  --jsonOut report.json

  常用可配置参数（都用 --xxx value）
  --url：目标地址
  默认 [http://127.0.0.1](http://127.0.0.1):3000
  --clients：客户端数
  默认 300
  --rampPerSec：每秒新建多少连接（渐进压测）
  默认 50
  --durationSec：持续秒数
  默认 60
  --intervalMs：每个客户端发包间隔
  默认 1000
  --kbPerSecPerClient：每客户端每秒发送 KB（脚本会换算到每个 tick 的 payload size）
  默认 4
  --sendEvent：发送的 socket event 名
  默认 mobile:ping（服务端没监听也没关系，仍可用于纯链路带宽/连接稳定性测试）
  --useAck 1：开启 ack + 延迟统计（需要服务端对 sendEvent 做 ack 才有意义）
  默认关闭
  --ackTimeoutMs：ack 超时
  默认 3000
  --reconnect 1/0：是否允许断线重连
  默认 1
  --maxReconnectionAttempts：重连次数
  默认 5
  --logEverySec：控制台每隔多少秒打印一次实时指标
  默认 5
  --jsonOut：输出完整 JSON 报告到文件
  例：--jsonOut report.json
 */
const { io } = require('socket.io-client');


function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next == null || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function toInt(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : def;
}

function toFloat(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function nowMs() {
  return Date.now();
}

function formatBytes(bytes) {
  const b = Number(bytes || 0);
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(2)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(2)} MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatBps(bytesPerSec) {
  const v = Number(bytesPerSec || 0);
  return `${formatBytes(v)}/s`;
}

function percentile(sorted, p) {
  if (!Array.isArray(sorted) || sorted.length === 0) return null;
  const idx = clamp(Math.floor((p / 100) * (sorted.length - 1)), 0, sorted.length - 1);
  return sorted[idx];
}

function buildPayloadBytes(sizeBytes) {
  const n = Math.max(0, Math.trunc(sizeBytes));
  const buf = Buffer.allocUnsafe(n);
  // Fill with deterministic but non-trivial data
  for (let i = 0; i < n; i += 1) buf[i] = (i * 31 + 17) & 0xff;
  return buf;
}

async function main() {
  const args = parseArgs(process.argv);

  const url = String(args.url || 'http://127.0.0.1:3000');
  const clients = toInt(args.clients, 300);
  const rampPerSec = toInt(args.rampPerSec, 50); // clients per second
  const durationSec = toInt(args.durationSec, 60);
  const intervalMs = toInt(args.intervalMs, 1000);
  const kbPerSecPerClient = toFloat(args.kbPerSecPerClient, 4); // per client per second
  const sendEvent = String(args.sendEvent || 'mobile:ping');
  const useAck = String(args.useAck || '0') === '1';
  const ackTimeoutMs = toInt(args.ackTimeoutMs, 3000);
  const reconnect = String(args.reconnect || '1') === '1';
  const maxReconnectionAttempts = toInt(args.maxReconnectionAttempts, 5);
  const logEverySec = toInt(args.logEverySec, 5);
  const jsonOut = args.jsonOut ? String(args.jsonOut) : '';

  const payloadBytesPerSec = Math.max(0, Math.floor(kbPerSecPerClient * 1024));
  const bytesPerTick = Math.floor((payloadBytesPerSec * intervalMs) / 1000);
  const payload = buildPayloadBytes(bytesPerTick);

  const startedAt = nowMs();
  const stopAt = startedAt + durationSec * 1000;

  const metrics = {
    url,
    config: {
      clients,
      rampPerSec,
      durationSec,
      intervalMs,
      kbPerSecPerClient,
      sendEvent,
      useAck,
      ackTimeoutMs,
      reconnect,
      maxReconnectionAttempts,
    },
    counters: {
      created: 0,
      connected: 0,
      connectErrors: 0,
      disconnected: 0,
      disconnectReasons: {},
      sendAttempts: 0,
      sendSuccess: 0,
      sendErrors: 0,
      acksOk: 0,
      acksTimeout: 0,
      bytesSent: 0,
      bytesReceived: 0,
    },
    latencyMs: [],
    perSecond: [],
  };

  const sockets = new Map();

  function incReason(reason) {
    const r = String(reason || 'unknown');
    metrics.counters.disconnectReasons[r] = (metrics.counters.disconnectReasons[r] || 0) + 1;
  }

  function snapshotSecond(tsMs, last) {
    const t = Math.floor((tsMs - startedAt) / 1000);
    const sent = metrics.counters.bytesSent;
    const recv = metrics.counters.bytesReceived;
    const sendAttempts = metrics.counters.sendAttempts;
    const sendSuccess = metrics.counters.sendSuccess;
    const acksOk = metrics.counters.acksOk;
    const acksTimeout = metrics.counters.acksTimeout;

    const sentDelta = sent - last.sent;
    const recvDelta = recv - last.recv;
    const sendAttemptsDelta = sendAttempts - last.sendAttempts;
    const sendSuccessDelta = sendSuccess - last.sendSuccess;
    const acksOkDelta = acksOk - last.acksOk;
    const acksTimeoutDelta = acksTimeout - last.acksTimeout;

    metrics.perSecond.push({
      t,
      connected: metrics.counters.connected - metrics.counters.disconnected,
      sentBps: sentDelta,
      recvBps: recvDelta,
      sendAttempts: sendAttemptsDelta,
      sendSuccess: sendSuccessDelta,
      acksOk: acksOkDelta,
      acksTimeout: acksTimeoutDelta,
    });

    last.sent = sent;
    last.recv = recv;
    last.sendAttempts = sendAttempts;
    last.sendSuccess = sendSuccess;
    last.acksOk = acksOk;
    last.acksTimeout = acksTimeout;
  }

  function createClient(i) {
    const socket = io(url, {
      transports: ['websocket'],
      reconnection: reconnect,
      reconnectionAttempts: maxReconnectionAttempts,
      timeout: 10000,
    });

    metrics.counters.created += 1;

    const state = {
      id: i,
      connected: false,
      createdAt: nowMs(),
      sendTimer: null,
    };

    sockets.set(socket, state);

    socket.on('connect', () => {
      if (!state.connected) {
        state.connected = true;
        metrics.counters.connected += 1;
      }

      if (!state.sendTimer) {
        state.sendTimer = setInterval(async () => {
          const t = nowMs();
          if (t >= stopAt) return;

          metrics.counters.sendAttempts += 1;
          metrics.counters.bytesSent += payload.length;

          if (!useAck) {
            socket.emit(sendEvent, { i, t, payload });
            metrics.counters.sendSuccess += 1;
            return;
          }

          const begin = nowMs();
          let timeout = null;
          let done = false;

          try {
            const ackPromise = new Promise((resolve, reject) => {
              timeout = setTimeout(() => reject(new Error('ack_timeout')), ackTimeoutMs);
              socket.timeout(ackTimeoutMs).emit(sendEvent, { i, t, payload }, (err, res) => {
                if (err) return reject(err);
                resolve(res);
              });
            });

            await ackPromise;
            done = true;
            metrics.counters.acksOk += 1;
            metrics.counters.sendSuccess += 1;
            metrics.latencyMs.push(nowMs() - begin);
          } catch (e) {
            const msg = String((e && e.message) || e || 'error');
            if (msg.includes('ack_timeout')) metrics.counters.acksTimeout += 1;
            else metrics.counters.sendErrors += 1;
          } finally {
            if (timeout) clearTimeout(timeout);
            if (!done) {
              // counted in sendAttempts already
            }
          }
        }, intervalMs);
      }
    });

    socket.on('disconnect', (reason) => {
      if (state.connected) {
        state.connected = false;
        metrics.counters.disconnected += 1;
      }
      incReason(reason);
      if (state.sendTimer) {
        clearInterval(state.sendTimer);
        state.sendTimer = null;
      }
    });

    socket.on('connect_error', (err) => {
      metrics.counters.connectErrors += 1;
      const msg = String((err && err.message) || err || 'connect_error');
      incReason(`connect_error:${msg}`);
    });

    // generic catch-all for incoming events, count bytes by rough JSON size
    socket.onAny((event, ...argsAny) => {
      if (event === 'connect' || event === 'disconnect') return;
      try {
        const size = Buffer.byteLength(JSON.stringify({ event, args: argsAny }));
        metrics.counters.bytesReceived += size;
      } catch {
        metrics.counters.bytesReceived += 0;
      }
    });

    return socket;
  }

  console.log('--- Mobile Load Test ---');
  console.log(`Target URL: ${url}`);
  console.log(`Clients: ${clients}, Ramp: ${rampPerSec}/s, Duration: ${durationSec}s`);
  console.log(`Interval: ${intervalMs}ms, Payload per tick: ${payload.length} bytes (${(payload.length / 1024).toFixed(2)} KB)`);
  console.log(`Approx per-client send rate: ${formatBps(payloadBytesPerSec)} (target), total target: ${formatBps(payloadBytesPerSec * clients)}`);
  console.log(`Send event: ${sendEvent}, Ack: ${useAck ? 'on' : 'off'}`);

  updateProcessTitle();

  const createdSockets = [];
  const rampIntervalMs = 1000;
  const rampStep = Math.max(1, rampPerSec);

  // ramp up
  while (createdSockets.length < clients) {
    const now = nowMs();
    if (now >= stopAt) break;

    const remain = clients - createdSockets.length;
    const batch = Math.min(remain, rampStep);
    for (let i = 0; i < batch; i += 1) {
      createdSockets.push(createClient(createdSockets.length + 1));
    }

    await sleep(rampIntervalMs);
  }

  // periodic logging + per-second snapshots
  const last = { sent: 0, recv: 0, sendAttempts: 0, sendSuccess: 0, acksOk: 0, acksTimeout: 0 };
  let lastLogAt = startedAt;

  while (nowMs() < stopAt) {
    const t = nowMs();
    snapshotSecond(t, last);

    if ((t - lastLogAt) / 1000 >= logEverySec) {
      lastLogAt = t;
      const active = metrics.counters.connected - metrics.counters.disconnected;
      const sec = metrics.perSecond[metrics.perSecond.length - 1];
      console.log(
        `[t+${sec.t}s] active=${active} sent=${formatBps(sec.sentBps)} recv=${formatBps(sec.recvBps)} sendOk=${sec.sendSuccess}/${sec.sendAttempts} ackOk=${sec.acksOk} ackTimeout=${sec.acksTimeout}`
      );
    }

    await sleep(1000);
  }

  // final snapshot
  snapshotSecond(nowMs(), last);

  // shutdown
  for (const s of createdSockets) {
    try {
      s.disconnect();
      s.close();
    } catch {
      // ignore
    }
  }

  const endedAt = nowMs();
  const elapsedSec = Math.max(1, (endedAt - startedAt) / 1000);

  const perSec = metrics.perSecond;
  const sentBpsArr = perSec.map((x) => x.sentBps).slice(1);
  const recvBpsArr = perSec.map((x) => x.recvBps).slice(1);

  const sentPeak = sentBpsArr.length ? Math.max(...sentBpsArr) : 0;
  const sentValley = sentBpsArr.length ? Math.min(...sentBpsArr) : 0;
  const recvPeak = recvBpsArr.length ? Math.max(...recvBpsArr) : 0;
  const recvValley = recvBpsArr.length ? Math.min(...recvBpsArr) : 0;

  const activeEnd = metrics.counters.connected - metrics.counters.disconnected;
  const disconnectRate = metrics.counters.connected > 0 ? metrics.counters.disconnected / metrics.counters.connected : 0;

  const latencySorted = metrics.latencyMs.slice().sort((a, b) => a - b);
  const latency = {
    count: latencySorted.length,
    p50: percentile(latencySorted, 50),
    p90: percentile(latencySorted, 90),
    p99: percentile(latencySorted, 99),
    max: latencySorted.length ? latencySorted[latencySorted.length - 1] : null,
    min: latencySorted.length ? latencySorted[0] : null,
  };

  const report = {
    ...metrics,
    summary: {
      startedAt,
      endedAt,
      elapsedSec,
      connectedTotal: metrics.counters.connected,
      disconnectedTotal: metrics.counters.disconnected,
      activeEnd,
      disconnectRate,
      bytesSent: metrics.counters.bytesSent,
      bytesReceived: metrics.counters.bytesReceived,
      avgSentBps: Math.round(metrics.counters.bytesSent / elapsedSec),
      avgRecvBps: Math.round(metrics.counters.bytesReceived / elapsedSec),
      sentPeakBps: sentPeak,
      sentValleyBps: sentValley,
      recvPeakBps: recvPeak,
      recvValleyBps: recvValley,
      latencyMs: latency,
    },
  };

  console.log('\n--- Summary ---');
  console.log(`Created: ${report.counters.created}`);
  console.log(`Connected(total): ${report.summary.connectedTotal}`);
  console.log(`Disconnected(total): ${report.summary.disconnectedTotal} (${(report.summary.disconnectRate * 100).toFixed(2)}%)`);
  console.log(`Active(end): ${report.summary.activeEnd}`);
  console.log(`Sent(total): ${formatBytes(report.summary.bytesSent)} (avg ${formatBps(report.summary.avgSentBps)}, peak ${formatBps(report.summary.sentPeakBps)}, valley ${formatBps(report.summary.sentValleyBps)})`);
  console.log(
    `Recv(total): ${formatBytes(report.summary.bytesReceived)} (avg ${formatBps(report.summary.avgRecvBps)}, peak ${formatBps(report.summary.recvPeakBps)}, valley ${formatBps(report.summary.recvValleyBps)})`
  );
  console.log(
    `Send success: ${report.counters.sendSuccess}/${report.counters.sendAttempts} | Ack ok: ${report.counters.acksOk} | Ack timeout: ${report.counters.acksTimeout}`
  );
  if (report.summary.latencyMs.count > 0) {
    console.log(
      `Latency(ms): p50=${report.summary.latencyMs.p50} p90=${report.summary.latencyMs.p90} p99=${report.summary.latencyMs.p99} min=${report.summary.latencyMs.min} max=${report.summary.latencyMs.max}`
    );
  }

  const reasons = Object.entries(report.counters.disconnectReasons || {}).sort((a, b) => b[1] - a[1]);
  if (reasons.length > 0) {
    console.log('\n--- Disconnect Reasons (top) ---');
    for (const [k, v] of reasons.slice(0, 20)) {
      console.log(`${k}: ${v}`);
    }
  }

  if (jsonOut) {
    const fs = require('fs');
    fs.writeFileSync(jsonOut, JSON.stringify(report, null, 2), 'utf-8');
    console.log(`\nReport written: ${jsonOut}`);
  }

  process.exit(0);

  function updateProcessTitle() {
    try {
      process.title = `stall-mobile-load-test ${clients} clients`;
    } catch {
      // ignore
    }
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
}

main().catch((e) => {
  console.error('Load test failed:', e);
  process.exit(1);
});
