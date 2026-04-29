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
      return res.json();
    }

    // Cache for practitioner names
    const pracCache = {};
    async function getPracName(links) {
      if (!links?.self) return 'Unknown';
      const pracId = links.self.split('/').pop();
      if (!pracCache[pracId]) {
        try {
          const prac = await clinikoGet(`practitioners/${pracId}`);
          pracCache[pracId] = `${prac.first_name} ${prac.last_name}`;
        } catch(e) { pracCache[pracId] = 'Unknown'; }
      }
      return pracCache[pracId];
    }

    const action = url.searchParams.get('action') || '';

    // ── GET APPOINTMENTS IN DATE RANGE ────────────────
    if (action === 'get_appointments_range') {
      const from = url.searchParams.get('from') || '';
      const to = url.searchParams.get('to') || '';

      // Get total to find last page
      const countData = await clinikoGet(`appointments?per_page=1&page=1`);
      const total = countData.total_entries || 0;
      const totalPages = Math.ceil(total / 100);

      let allAppts = [];
      const startPage = Math.max(1, totalPages);
      const endPage = Math.max(1, totalPages - 20);

      for (let page = startPage; page >= endPage; page--) {
        const data = await clinikoGet(`appointments?sort=starts_at&order=asc&per_page=100&page=${page}`);
        const appts = data.appointments || [];
        const inRange = appts.filter(a => {
          const d = a.starts_at?.slice(0,10);
          return d >= from && d <= to;
        });
        allAppts = allAppts.concat(inRange);
        const firstAppt = appts[0];
        if (firstAppt && firstAppt.starts_at?.slice(0,10) < from) break;
      }

      // Enrich with practitioner names
      const enriched = await Promise.all(allAppts.map(async (a) => {
        const pracName = await getPracName(a.practitioner?.links);
        return { ...a, practitioner_name: pracName };
      }));

      return new Response(JSON.stringify({ appointments: enriched }), { headers: corsHeaders });

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

    // ── GET INVOICES IN DATE RANGE ───────────────────
    } else if (action === 'get_invoices_range') {
      const from = url.searchParams.get('from') || '';
      const to = url.searchParams.get('to') || '';

      let allInvoices = [];
      let page = 1;
      let hasMore = true;

      while (hasMore && page <= 20) {
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

    // ── GET UPCOMING APPOINTMENTS ────────────────────
    } else if (action === 'get_upcoming') {
      const today = url.searchParams.get('today') || new Date().toISOString().slice(0,10);
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 60);
      const future = futureDate.toISOString().slice(0,10);

      // Get total appointments to find last pages for upcoming
      const countData = await clinikoGet(`appointments?per_page=1&page=1`);
      const total = countData.total_entries || 0;
      const totalPages = Math.ceil(total / 100);

      let upcoming = [];
      // Fetch last few pages for upcoming appointments
      for (let page = totalPages; page >= Math.max(1, totalPages - 5); page--) {
        const data = await clinikoGet(`appointments?sort=starts_at&order=asc&per_page=100&page=${page}`);
        const appts = data.appointments || [];
        const inRange = appts.filter(a => {
          const d = a.starts_at?.slice(0,10);
          return d >= today && d <= future && !a.cancelled_at;
        });
        upcoming = upcoming.concat(inRange);
      }

      // Get unique patient IDs with upcoming appointments
      const patientsWithUpcoming = new Set(
        upcoming.map(a => a.patient?.links?.self?.split('/').pop()).filter(Boolean)
      );

      return new Response(JSON.stringify({
        upcoming_count: upcoming.length,
        patient_ids_with_upcoming: [...patientsWithUpcoming]
      }), { headers: corsHeaders });

    } else {
      return new Response(JSON.stringify({ error: 'Unknown action' }), { status: 400, headers: corsHeaders });
    }
  }
};
