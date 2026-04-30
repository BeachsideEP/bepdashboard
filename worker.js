const CLINIKO_BASE = 'https://api.au2.cliniko.com/v1';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Content-Type': 'application/json',
    };

    if (request.method === 'OPTIONS') {
      return new Response('', { headers: corsHeaders });
    }

    const DASH_EMAIL    = env.DASHBOARD_EMAIL    || 'admin@beachsideep.com.au';
    const DASH_PASSWORD = env.DASHBOARD_PASSWORD || 'Theo123*';
    const CLINIKO_KEY   = env.CLINIKO_API_KEY    || 'MS0xOTM4NzEyOTY5NjA5MjIyMjk4LW5oZXVTQVYxVTIzRVdVMXdtQUR1NFRiYlMzMHY2SHR0-au2';

    // ── AUTH ─────────────────────────────────────────
    if (url.pathname === '/auth/login') {
      try {
        const body = await request.json();
        if (body.email === DASH_EMAIL && body.password === DASH_PASSWORD) {
          const token = btoa(DASH_EMAIL + ':' + Date.now());
          return new Response(JSON.stringify({ token }), { headers: corsHeaders });
        }
        return new Response(JSON.stringify({ error: 'Invalid credentials' }), { status: 401, headers: corsHeaders });
      } catch(e) {
        return new Response(JSON.stringify({ error: 'Invalid request' }), { status: 400, headers: corsHeaders });
      }
    }

    // ── TOKEN CHECK ──────────────────────────────────
    const authHeader = request.headers.get('Authorization') || '';
    const token = authHeader.replace('Bearer ', '');
    if (!token) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders });
    }
    try {
      const decoded = atob(token);
      if (!decoded.startsWith(DASH_EMAIL)) throw new Error('Invalid token');
    } catch(e) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders });
    }

    const creds = btoa(CLINIKO_KEY + ':');
    const authHeaders = {
      'Authorization': 'Basic ' + creds,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'BEP-Dashboard/1.0 (admin@beachsideep.com.au)',
    };

    // Fetch a single Cliniko page
    async function clinikoGet(path) {
      const res = await fetch(`${CLINIKO_BASE}/${path}`, { headers: authHeaders });
      if (!res.ok) throw new Error(`Cliniko ${res.status}: ${path}`);
      return res.json();
    }

    // Fetch all pages, stopping when predicate(lastItem) returns false
    async function clinikoGetAll(path, stopWhen, maxPages = 50) {
      let items = [];
      let page = 1;
      while (page <= maxPages) {
        const sep = path.includes('?') ? '&' : '?';
        const data = await clinikoGet(`${path}${sep}per_page=100&page=${page}`);
        const key = Object.keys(data).find(k => Array.isArray(data[k]));
        const batch = key ? data[key] : [];
        if (!batch.length) break;
        items = items.concat(batch);
        const last = batch[batch.length - 1];
        if (batch.length < 100 || !data.links?.next || (stopWhen && !stopWhen(last))) break;
        page++;
      }
      return items;
    }

    const action = url.searchParams.get('action') || '';

    // ── GET PRACTITIONERS ────────────────────────────
    if (action === 'get_practitioners') {
      const data = await clinikoGet('practitioners?per_page=100');
      const lookup = {};
      (data.practitioners || []).forEach(p => {
        lookup[p.id] = `${p.first_name} ${p.last_name}`.trim();
      });
      return new Response(JSON.stringify({ practitioners: lookup }), { headers: corsHeaders });

    // ── GET APPOINTMENTS IN DATE RANGE ───────────────
    } else if (action === 'get_appointments_range') {
      const from = url.searchParams.get('from') || '';
      const to   = url.searchParams.get('to')   || '';
      if (!from || !to) {
        return new Response(JSON.stringify({ error: 'from and to required' }), { status: 400, headers: corsHeaders });
      }

      // Fetch active appointments in range
      const activeBase = `appointments?sort=starts_at&order=asc&q[]=starts_at:>=${from} 00:00:00&q[]=starts_at:<=${to} 23:59:59`;
      const activeAppts = await clinikoGetAll(activeBase, last => last.starts_at?.slice(0,10) <= to, 30);

      // Fetch cancelled appointments in range separately (Cliniko filters these out by default)
      const cancelBase = `appointments?sort=starts_at&order=asc&q[]=starts_at:>=${from} 00:00:00&q[]=starts_at:<=${to} 23:59:59&q[]=cancelled_at:>=2000-01-01`;
      const cancelAppts = await clinikoGetAll(cancelBase, last => last.starts_at?.slice(0,10) <= to, 30);

      // Merge — dedupe by id, cancelled record wins
      const merged = {};
      activeAppts.forEach(a => { merged[a.id] = a; });
      cancelAppts.forEach(a => { merged[a.id] = a; }); // overwrites with cancelled version
      const all = Object.values(merged);

      return new Response(JSON.stringify({ appointments: all, total: all.length, active: activeAppts.length, cancelled: cancelAppts.length }), { headers: corsHeaders });

    // ── GET NEW PATIENTS IN DATE RANGE ───────────────
    } else if (action === 'get_new_patients') {
      const from = url.searchParams.get('from') || '';
      const to   = url.searchParams.get('to')   || '';
      if (!from || !to) {
        return new Response(JSON.stringify({ error: 'from and to required' }), { status: 400, headers: corsHeaders });
      }

      const base = `patients?sort=created_at&order=desc&q[]=created_at:>=${from} 00:00:00&q[]=created_at:<=${to} 23:59:59`;
      const patients = await clinikoGetAll(base, last => last.created_at?.slice(0,10) >= from, 10);
      return new Response(JSON.stringify({ patients }), { headers: corsHeaders });

    // ── GET INVOICES IN DATE RANGE ───────────────────
    } else if (action === 'get_invoices_range') {
      const from = url.searchParams.get('from') || '';
      const to   = url.searchParams.get('to')   || '';
      if (!from || !to) {
        return new Response(JSON.stringify({ error: 'from and to required' }), { status: 400, headers: corsHeaders });
      }

      const base = `invoices?sort=created_at&order=desc&q[]=created_at:>=${from} 00:00:00&q[]=created_at:<=${to} 23:59:59`;
      const invoices = await clinikoGetAll(base, last => last.created_at?.slice(0,10) >= from, 50);
      return new Response(JSON.stringify({ invoices }), { headers: corsHeaders });

    } else {
      return new Response(JSON.stringify({ error: 'Unknown action' }), { status: 400, headers: corsHeaders });
    }
  }
};
