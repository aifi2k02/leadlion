// TEMPORARY diagnostic — measures how many outbound subrequests a Pages Function
// can make on this Cloudflare plan (Free = 50, Workers Paid = 1000).
// Fetches a trivial Cloudflare endpoint. Delete after measuring.
export async function onRequestGet(context) {
  const n = Math.min(600, Number(new URL(context.request.url).searchParams.get('n') || 60));
  let ok = 0;
  let failedAt = null;
  let error = null;
  try {
    for (let i = 0; i < n; i++) {
      const res = await fetch('https://cloudflare.com/cdn-cgi/trace', { cf: { cacheTtl: 0 } });
      await res.text();
      ok++;
    }
  } catch (e) {
    failedAt = ok + 1;
    error = String(e?.message || e).slice(0, 160);
  }
  return new Response(JSON.stringify({ requested: n, succeeded: ok, failedAt, error }, null, 2), {
    headers: { 'Content-Type': 'application/json' },
  });
}
