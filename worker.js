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
    const clinikoHeaders = {
      'Authorization': 'Basic ' + creds,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'BEP-Dashboard/1.0 (admin@beachsideep.com.au)',
    };

    async function clinikoGet(path) {
      const res = await fetch(`${CLINIKO_BASE}/${path}`, { headers: clinikoHeaders });
      const text = await res.text();
      if (!res.ok) throw new Error(`Cliniko ${res.status}: ${text.slice(0,300)}`);
      return JSON.parse(text);
    }

    const action = url.searchParams.get('action') || '';

    try {

      // ── GET PRACTITIONERS ──────────────────────────
      if (action === 'get_practitioners') {
        const data = await clinikoGet('practitioners?per_page=100');
        const lookup = {};
        (data.practitioners || []).forEach(p => {
          lookup[p.id] = `${p.first_name} ${p.last_name}`.trim();
        });
        return new Response(JSON.stringify({ practitioners: lookup }), { headers: corsHeaders });

      // ── GET APPOINTMENTS IN DATE RANGE ─────────────
      } else if (action === 'get_appointments_range') {
        const from = url.searchParams.get('from') || '';
        const to   = url.searchParams.get('to')   || '';
        if (!from || !to) {
          return new Response(JSON.stringify({ error: 'from and to required' }), { status: 400, headers: corsHeaders });
        }

        // Find total pages
        const countData = await clinikoGet('appointments?per_page=1&page=1');
        const total = countData.total_entries || 0;
        const totalPages = Math.ceil(total / 100);

        // Fetch pages from the end backwards — appointments are newest-last,
        // so the date range is near the last pages
        let activeAppts = [];
        for (let page = totalPages; page >= Math.max(1, totalPages - 25); page--) {
          const data = await clinikoGet(`appointments?sort=starts_at&order=asc&per_page=100&page=${page}`);
          const appts = data.appointments || [];
          if (!appts.length) break;
          const inRange = appts.filter(a => {
            const d = a.starts_at?.slice(0,10);
            return d >= from && d <= to;
          });
          activeAppts = activeAppts.concat(inRange);
          // Stop if we've gone past the start of our range
          if (appts[0]?.starts_at?.slice(0,10) < from) break;
        }

        // Fetch cancelled appointments — Cliniko has a dedicated endpoint for these
        // cancelled_at is set; they don't appear in the regular appointments endpoint
        const cancelCount = await clinikoGet('appointments?per_page=1&page=1&cancelled=true');
        const cancelTotal = cancelCount.total_entries || 0;
        const cancelPages = Math.ceil(cancelTotal / 100);

        let cancelAppts = [];
        for (let page = cancelPages; page >= Math.max(1, cancelPages - 10); page--) {
          const data = await clinikoGet(`appointments?sort=starts_at&order=asc&per_page=100&page=${page}&cancelled=true`);
          const appts = data.appointments || [];
          if (!appts.length) break;
          const inRange = appts.filter(a => {
            const d = a.starts_at?.slice(0,10);
            return d >= from && d <= to;
          });
          cancelAppts = cancelAppts.concat(inRange);
          if (appts[0]?.starts_at?.slice(0,10) < from) break;
        }

        // Merge — cancelled record overwrites if same ID
        const merged = {};
        activeAppts.forEach(a => { merged[a.id] = a; });
        cancelAppts.forEach(a => { merged[a.id] = a; });
        const all = Object.values(merged);

        return new Response(JSON.stringify({
          appointments: all,
          total: all.length,
          active_count: activeAppts.length,
          cancelled_count: cancelAppts.length,
        }), { headers: corsHeaders });

      // ── GET NEW PATIENTS IN DATE RANGE ─────────────
      } else if (action === 'get_new_patients') {
        const from = url.searchParams.get('from') || '';
        const to   = url.searchParams.get('to')   || '';
        if (!from || !to) {
          return new Response(JSON.stringify({ error: 'from and to required' }), { status: 400, headers: corsHeaders });
        }

        let allPatients = [];
        let page = 1;
        let hasMore = true;
        while (hasMore && page <= 10) {
          const data = await clinikoGet(`patients?sort=created_at&order=desc&per_page=100&page=${page}`);
          const patients = data.patients || [];
          const filtered = patients.filter(p => {
            const d = p.created_at?.slice(0,10);
            return d >= from && d <= to;
          });
          allPatients = allPatients.concat(filtered);
          const last = patients[patients.length - 1];
          hasMore = !!data.links?.next && patients.length === 100 && (!last || last.created_at?.slice(0,10) >= from);
          page++;
        }
        return new Response(JSON.stringify({ patients: allPatients }), { headers: corsHeaders });

      // ── GET INVOICES IN DATE RANGE ─────────────────
      } else if (action === 'get_invoices_range') {
        const from = url.searchParams.get('from') || '';
        const to   = url.searchParams.get('to')   || '';
        if (!from || !to) {
          return new Response(JSON.stringify({ error: 'from and to required' }), { status: 400, headers: corsHeaders });
        }

        let allInvoices = [];
        let page = 1;
        let hasMore = true;
        while (hasMore && page <= 50) {
          const data = await clinikoGet(`invoices?sort=created_at&order=desc&per_page=100&page=${page}`);
          const invoices = data.invoices || [];
          const filtered = invoices.filter(i => {
            const d = i.created_at?.slice(0,10);
            return d >= from && d <= to;
          });
          allInvoices = allInvoices.concat(filtered);
          const last = invoices[invoices.length - 1];
          hasMore = !!data.links?.next && invoices.length === 100 && (!last || last.created_at?.slice(0,10) >= from);
          page++;
        }
        return new Response(JSON.stringify({ invoices: allInvoices }), { headers: corsHeaders });

      } else {
        return new Response(JSON.stringify({ error: 'Unknown action' }), { status: 400, headers: corsHeaders });
      }

    } catch(e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
    }
  }
};
