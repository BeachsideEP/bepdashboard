const CLINIKO_BASE = 'https://api.au2.cliniko.com/v1';

export default {
  async fetch(request, env) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Content-Type': 'application/json',
    };

    if (request.method === 'OPTIONS') {
      return new Response('', { headers: corsHeaders });
    }

    try {
      return await handleRequest(request, env, corsHeaders);
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message || 'Internal error' }), {
        status: 500,
        headers: corsHeaders,
      });
    }
  }
};

async function handleRequest(request, env, corsHeaders) {
    const url = new URL(request.url);

    const DASH_EMAIL = env.DASHBOARD_EMAIL || 'admin@beachsideep.com.au';
    const DASH_PASSWORD = env.DASHBOARD_PASSWORD || 'Theo123*';
    const CLINIKO_KEY = env.CLINIKO_API_KEY || 'MS0xOTM4NzEyOTY5NjA5MjIyMjk4LW5oZXVTQVYxVTIzRVdVMXdtQUR1NFRiYlMzMHY2SHR0-au2';

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

    const API_KEY = CLINIKO_KEY;
    const creds = btoa(API_KEY + ':');
    const authHeaders = {
      'Authorization': 'Basic ' + creds,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'BEP-Dashboard/1.0 (admin@beachsideep.com.au)',
    };

    async function clinikoGet(path) {
      const res = await fetch(`${CLINIKO_BASE}/${path}`, { headers: authHeaders });
      if (!res.ok) {
        let body = '';
        try { body = await res.text(); } catch(_) {}
        throw new Error(`Cliniko API error ${res.status} on ${path}: ${body.slice(0, 200)}`);
      }
      return res.json();
    }

    const action = url.searchParams.get('action') || '';

    // ── GET ALL PRACTITIONERS (cached lookup) ─────────
    if (action === 'get_practitioners') {
      const data = await clinikoGet('practitioners?per_page=100');
      const practitioners = data.practitioners || [];
      const lookup = {};
      practitioners.forEach(p => { lookup[p.id] = `${p.first_name} ${p.last_name}`; });
      return new Response(JSON.stringify({ practitioners: lookup }), { headers: corsHeaders });

    // ── GET APPOINTMENTS IN DATE RANGE ────────────────
    } else if (action === 'get_appointments_range') {
      const from = url.searchParams.get('from') || '';
      const to = url.searchParams.get('to') || '';

      let allAppts = [];
      let page = 1;
      let hasMore = true;

      while (hasMore && page <= 100) {
        const data = await clinikoGet(`appointments?sort=starts_at&order=asc&per_page=100&page=${page}`);
        const appts = data.appointments || [];

        if (appts.length === 0) break;

        for (const a of appts) {
          const apptDate = a.starts_at?.slice(0, 10);
          if (!apptDate) continue;
          if (apptDate >= from && apptDate <= to) {
            allAppts.push(a);
          }
        }

        // If the last appointment on this page is already past `to`, stop fetching
        const lastAppt = appts[appts.length - 1];
        const lastDate = lastAppt?.starts_at?.slice(0, 10);
        if (lastDate && lastDate > to) break;

        hasMore = !!data.links?.next && appts.length === 100;
        page++;
      }

      return new Response(JSON.stringify({ appointments: allAppts }), { headers: corsHeaders });

    // ── GET NEW PATIENTS IN DATE RANGE ───────────────
    } else if (action === 'get_new_patients') {
      const from = url.searchParams.get('from') || '';
      const to = url.searchParams.get('to') || '';

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

    // ── GET ALL INVOICES ─────────────────────────────
    } else if (action === 'get_invoices_range') {
      const from = url.searchParams.get('from') || '';
      const to = url.searchParams.get('to') || '';

      let allInvoices = [];
      let page = 1;
      let hasMore = true;

      // Fetch all invoices sorted newest first
      while (hasMore && page <= 50) {
        const data = await clinikoGet(`invoices?sort=created_at&order=desc&per_page=100&page=${page}`);
        const invoices = data.invoices || [];
        const filtered = invoices.filter(i => {
          const d = i.created_at?.slice(0,10);
          return d >= from && d <= to;
        });
        allInvoices = allInvoices.concat(filtered);
        const last = invoices[invoices.length - 1];
        // Stop if we've gone past the start date
        hasMore = !!data.links?.next && invoices.length === 100 && (!last || last.created_at?.slice(0,10) >= from);
        page++;
      }

      return new Response(JSON.stringify({ invoices: allInvoices }), { headers: corsHeaders });

    } else {
      return new Response(JSON.stringify({ error: 'Unknown action' }), { status: 400, headers: corsHeaders });
    }
}
