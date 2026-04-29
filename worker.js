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

    // ── AUTH ──────────────────────────────────────────
    if (url.pathname === '/auth/login') {
      const body = await request.json();
      if (body.email === env.DASHBOARD_EMAIL && body.password === env.DASHBOARD_PASSWORD) {
        const token = btoa(env.DASHBOARD_EMAIL + ':' + Date.now());
        return new Response(JSON.stringify({ token }), { headers: corsHeaders });
      }
      return new Response(JSON.stringify({ error: 'Invalid credentials' }), { status: 401, headers: corsHeaders });
    }

    // ── VERIFY TOKEN ──────────────────────────────────
    const authHeader = request.headers.get('Authorization') || '';
    const token = authHeader.replace('Bearer ', '');
    if (!token) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders });
    }
    try {
      const decoded = atob(token);
      if (!decoded.startsWith(env.DASHBOARD_EMAIL)) throw new Error('Invalid token');
    } catch(e) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders });
    }

    // ── CLINIKO API ───────────────────────────────────
    const API_KEY = env.CLINIKO_API_KEY;
    const creds = btoa(API_KEY + ':');
    const authHeaders = {
      'Authorization': 'Basic ' + creds,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'BEP-Dashboard/1.0 (admin@beachsideep.com.au)',
    };

    async function clinikoGet(path) {
      const res = await fetch(`${CLINIKO_BASE}/${path}`, { headers: authHeaders });
      return res.json();
    }

    const action = url.searchParams.get('action') || '';

    if (action === 'get_appointments_range') {
      const from = url.searchParams.get('from') || '';
      const to = url.searchParams.get('to') || '';

      let allAppts = [];
      let page = 1;
      let hasMore = true;
      const pracCache = {};

      while (hasMore && page <= 20) {
        const data = await clinikoGet(`appointments?sort=starts_at&order=asc&per_page=100&page=${page}`);
        const appts = data.appointments || [];
        const filtered = appts.filter(a => {
          const d = a.starts_at?.slice(0,10);
          return d >= from && d <= to;
        });
        allAppts = allAppts.concat(filtered);
        const last = appts[appts.length - 1];
        hasMore = !!data.links?.next && appts.length === 100 && (!last || last.starts_at?.slice(0,10) <= to);
        page++;
      }

      const enriched = await Promise.all(allAppts.map(async (a) => {
        let pracName = 'Unknown';
        if (a.practitioner?.links?.self) {
          const pracId = a.practitioner.links.self.split('/').pop();
          if (!pracCache[pracId]) {
            try {
              const prac = await clinikoGet(`practitioners/${pracId}`);
              pracCache[pracId] = `${prac.first_name} ${prac.last_name}`;
            } catch(e) { pracCache[pracId] = 'Unknown'; }
          }
          pracName = pracCache[pracId];
        }
        return { ...a, practitioner_name: pracName };
      }));

      return new Response(JSON.stringify({ appointments: enriched }), { headers: corsHeaders });

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

    } else {
      return new Response(JSON.stringify({ error: 'Unknown action' }), { status: 400, headers: corsHeaders });
    }
  }
};
