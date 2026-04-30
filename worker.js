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

    // Simple fetch — build URL as plain string, Cliniko accepts unencoded q[]
    async function clinikoFetch(path) {
      const fullUrl = `${CLINIKO_BASE}/${path}`;
      const res = await fetch(fullUrl, { headers: clinikoHeaders });
      const text = await res.text();
      if (!res.ok) throw new Error(`Cliniko ${res.status}: ${text.slice(0, 300)}`);
      return JSON.parse(text);
    }

    // Paginate — follows links.next until no more pages or stopWhen returns false
    async function fetchAll(firstPath, arrayKey, stopWhen, maxPages = 50) {
      let items = [];
      let path = firstPath;
      let page = 0;
      while (path && page < maxPages) {
        const data = await clinikoFetch(path);
        const batch = data[arrayKey] || [];
        items = items.concat(batch);
        page++;
        // Follow next link if present — strip the base URL
        const nextUrl = data.links?.next;
        if (!nextUrl || batch.length < 100) break;
        const last = batch[batch.length - 1];
        if (stopWhen && !stopWhen(last)) break;
        // Extract just the path+query from the full next URL
        path = nextUrl.replace(CLINIKO_BASE + '/', '');
      }
      return items;
    }

    const action = url.searchParams.get('action') || '';

    try {

      // ── GET PRACTITIONERS ──────────────────────────
      if (action === 'get_practitioners') {
        const data = await clinikoFetch('practitioners?per_page=100');
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

        // Active appointments in range
        const activePath = `appointments?per_page=100&sort=starts_at&order=asc&q[]=starts_at:>=${from} 00:00:00&q[]=starts_at:<=${to} 23:59:59`;
        const activeAppts = await fetchAll(activePath, 'appointments',
          last => last.starts_at?.slice(0,10) <= to, 30);

        // Cancelled appointments in same range (Cliniko excludes these from default response)
        const cancelPath = `appointments?per_page=100&sort=starts_at&order=asc&q[]=starts_at:>=${from} 00:00:00&q[]=starts_at:<=${to} 23:59:59&q[]=cancelled_at:>=2000-01-01`;
        const cancelAppts = await fetchAll(cancelPath, 'appointments',
          last => last.starts_at?.slice(0,10) <= to, 30);

        // Merge — cancelled record wins on duplicate IDs
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

        const path = `patients?per_page=100&sort=created_at&order=desc&q[]=created_at:>=${from} 00:00:00&q[]=created_at:<=${to} 23:59:59`;
        const patients = await fetchAll(path, 'patients',
          last => last.created_at?.slice(0,10) >= from, 10);

        return new Response(JSON.stringify({ patients }), { headers: corsHeaders });

      // ── GET INVOICES IN DATE RANGE ─────────────────
      } else if (action === 'get_invoices_range') {
        const from = url.searchParams.get('from') || '';
        const to   = url.searchParams.get('to')   || '';
        if (!from || !to) {
          return new Response(JSON.stringify({ error: 'from and to required' }), { status: 400, headers: corsHeaders });
        }

        const path = `invoices?per_page=100&sort=created_at&order=desc&q[]=created_at:>=${from} 00:00:00&q[]=created_at:<=${to} 23:59:59`;
        const invoices = await fetchAll(path, 'invoices',
          last => last.created_at?.slice(0,10) >= from, 50);

        return new Response(JSON.stringify({ invoices }), { headers: corsHeaders });

      } else {
        return new Response(JSON.stringify({ error: 'Unknown action' }), { status: 400, headers: corsHeaders });
      }

    } catch(e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
    }
  }
};
