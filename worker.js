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

    // Build a Cliniko URL with properly encoded q[] filters
    function clinikoUrl(endpoint, params = {}) {
      // Build query string manually so q[] brackets are encoded correctly
      const parts = [];
      for (const [k, v] of Object.entries(params)) {
        if (Array.isArray(v)) {
          v.forEach(val => parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(val)}`));
        } else {
          parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
        }
      }
      return `${CLINIKO_BASE}/${endpoint}${parts.length ? '?' + parts.join('&') : ''}`;
    }

    async function clinikoFetch(endpoint, params = {}) {
      const fullUrl = clinikoUrl(endpoint, params);
      const res = await fetch(fullUrl, { headers: clinikoHeaders });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Cliniko ${res.status}: ${text.slice(0, 200)}`);
      }
      return res.json();
    }

    // Paginate through all results
    async function fetchAll(endpoint, baseParams, arrayKey, stopWhen, maxPages = 50) {
      let items = [];
      let page = 1;
      while (page <= maxPages) {
        const data = await clinikoFetch(endpoint, { ...baseParams, per_page: 100, page });
        const batch = data[arrayKey] || [];
        if (!batch.length) break;
        items = items.concat(batch);
        const last = batch[batch.length - 1];
        if (batch.length < 100 || !data.links?.next || (stopWhen && !stopWhen(last))) break;
        page++;
      }
      return items;
    }

    const action = url.searchParams.get('action') || '';

    try {

      // ── GET PRACTITIONERS ──────────────────────────
      if (action === 'get_practitioners') {
        const data = await clinikoFetch('practitioners', { per_page: 100 });
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

        const baseParams = {
          sort: 'starts_at',
          order: 'asc',
          'q[]': [`starts_at:>=${from} 00:00:00`, `starts_at:<=${to} 23:59:59`],
        };

        // Active appointments
        const activeAppts = await fetchAll('appointments', baseParams, 'appointments',
          last => last.starts_at?.slice(0,10) <= to, 30);

        // Cancelled appointments — add cancelled_at filter
        const cancelParams = {
          ...baseParams,
          'q[]': [`starts_at:>=${from} 00:00:00`, `starts_at:<=${to} 23:59:59`, `cancelled_at:>=2000-01-01`],
        };
        const cancelAppts = await fetchAll('appointments', cancelParams, 'appointments',
          last => last.starts_at?.slice(0,10) <= to, 30);

        // Merge — cancelled record overwrites active (has cancelled_at populated)
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

        const patients = await fetchAll('patients', {
          sort: 'created_at',
          order: 'desc',
          'q[]': [`created_at:>=${from} 00:00:00`, `created_at:<=${to} 23:59:59`],
        }, 'patients', last => last.created_at?.slice(0,10) >= from, 10);

        return new Response(JSON.stringify({ patients }), { headers: corsHeaders });

      // ── GET INVOICES IN DATE RANGE ─────────────────
      } else if (action === 'get_invoices_range') {
        const from = url.searchParams.get('from') || '';
        const to   = url.searchParams.get('to')   || '';
        if (!from || !to) {
          return new Response(JSON.stringify({ error: 'from and to required' }), { status: 400, headers: corsHeaders });
        }

        const invoices = await fetchAll('invoices', {
          sort: 'created_at',
          order: 'desc',
          'q[]': [`created_at:>=${from} 00:00:00`, `created_at:<=${to} 23:59:59`],
        }, 'invoices', last => last.created_at?.slice(0,10) >= from, 50);

        return new Response(JSON.stringify({ invoices }), { headers: corsHeaders });

      } else {
        return new Response(JSON.stringify({ error: 'Unknown action' }), { status: 400, headers: corsHeaders });
      }

    } catch(e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
    }
  }
};
