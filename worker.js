/**
 * BEP Dashboard — Cloudflare Worker v3
 * Queries Supabase (pre-synced data) instead of Cliniko directly.
 * Zero subrequest limit issues — every action is a single Supabase fetch.
 *
 * Worker Environment Variables (set in Cloudflare dashboard):
 *   SUPABASE_URL        — https://xxxx.supabase.co
 *   SUPABASE_ANON_KEY   — your Supabase anon/public key (read-only, safe)
 *   DASHBOARD_EMAIL     — login email
 *   DASHBOARD_PASSWORD  — login password
 */

export default {
  async fetch(request, env) {
    const corsHeaders = {
      'Access-Control-Allow-Origin':  '*',
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
        status: 500, headers: corsHeaders,
      });
    }
  }
};

function supabase(env, table, params) {
  const url = `${env.SUPABASE_URL}/rest/v1/${table}${params ? '?' + params : ''}`;
  return fetch(url, {
    headers: {
      'apikey':        env.SUPABASE_ANON_KEY,
      'Authorization': 'Bearer ' + env.SUPABASE_ANON_KEY,
      'Accept':        'application/json',
    },
  });
}

async function handleRequest(request, env, corsHeaders) {
  const url = new URL(request.url);
  const DASH_EMAIL    = env.DASHBOARD_EMAIL    || 'admin@beachsideep.com.au';
  const DASH_PASSWORD = env.DASHBOARD_PASSWORD || 'Theo123*';

  if (url.pathname === '/auth/login') {
    const body = await request.json().catch(() => ({}));
    if (body.email === DASH_EMAIL && body.password === DASH_PASSWORD) {
      const token = btoa(DASH_EMAIL + ':' + Date.now());
      return new Response(JSON.stringify({ token }), { headers: corsHeaders });
    }
    return new Response(JSON.stringify({ error: 'Invalid credentials' }), { status: 401, headers: corsHeaders });
  }

  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.replace('Bearer ', '').trim();
  if (!token) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders });
  }
  try {
    const decoded = atob(token);
    if (!decoded.includes(':') || !decoded.includes('@')) throw new Error('Invalid token');
  } catch(e) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders });
  }

  const action = url.searchParams.get('action') || '';
  const from   = url.searchParams.get('from')   || '';
  const to     = url.searchParams.get('to')     || '';

  if (action === 'get_practitioners') {
    const res  = await supabase(env, 'practitioners', 'select=id,name&active=eq.true&order=name');
    if (!res.ok) throw new Error('Supabase error ' + res.status);
    const rows = await res.json();
    const lookup = {};
    rows.forEach(p => { lookup[p.id] = p.name; });
    return new Response(JSON.stringify({ practitioners: lookup }), { headers: corsHeaders });
  }

  if (action === 'get_appointments_range') {
    if (!from || !to) return new Response(JSON.stringify({ error: 'Missing from/to' }), { status: 400, headers: corsHeaders });
    const qs = `select=*&starts_at=gte.${from}T00:00:00&starts_at=lte.${to}T23:59:59&order=starts_at.asc&limit=5000`;
    const res = await supabase(env, 'dashboard_appointments', qs);
    if (!res.ok) { const b = await res.text(); throw new Error('Supabase ' + res.status + ': ' + b.slice(0,200)); }
    const rows = await res.json();
    const appointments = rows.map(r => ({
      id: r.id, starts_at: r.starts_at, ends_at: r.ends_at,
      status_clean: r.status_clean, is_completed: r.is_completed,
      is_dna: r.is_dna, is_cancelled: r.is_cancelled, is_group: r.is_group,
      cancelled_at: r.cancelled_at, cancellation_note: r.cancellation_note,
      treatment_note_status: r.treatment_note_status, actual_revenue: r.actual_revenue,
      appointment_type_name: r.appointment_type,
      patient_name: r.patient_name, practitioner_name: r.practitioner_name,
      _patId: r.patient_id ? String(r.patient_id) : null,
      did_not_arrive: r.is_dna, patient_arrived: r.is_completed,
    }));
    return new Response(JSON.stringify({ appointments }), { headers: corsHeaders });
  }

  if (action === 'get_new_patients') {
    if (!from || !to) return new Response(JSON.stringify({ error: 'Missing from/to' }), { status: 400, headers: corsHeaders });
    const qs = `select=id,first_name,last_name,referral_source,created_at&created_at=gte.${from}T00:00:00&created_at=lte.${to}T23:59:59&order=created_at.desc&limit=1000`;
    const res = await supabase(env, 'patients', qs);
    if (!res.ok) throw new Error('Supabase error ' + res.status);
    const patients = await res.json();
    return new Response(JSON.stringify({ patients }), { headers: corsHeaders });
  }

  if (action === 'get_invoices_range') {
    if (!from || !to) return new Response(JSON.stringify({ error: 'Missing from/to' }), { status: 400, headers: corsHeaders });
    const qs = `select=id,appointment_id,patient_id,practitioner_id,total_amount,status,created_at&created_at=gte.${from}T00:00:00&created_at=lte.${to}T23:59:59&order=created_at.desc&limit=5000`;
    const res = await supabase(env, 'invoices', qs);
    if (!res.ok) throw new Error('Supabase error ' + res.status);
    const invoices = await res.json();
    return new Response(JSON.stringify({ invoices }), { headers: corsHeaders });
  }

  if (action === 'get_sync_status') {
    const res  = await supabase(env, 'sync_state', 'select=*&order=entity');
    if (!res.ok) throw new Error('Supabase error ' + res.status);
    const rows = await res.json();
    const logRes = await supabase(env, 'sync_logs', 'select=*&order=started_at.desc&limit=10');
    const logs   = logRes.ok ? await logRes.json() : [];
    return new Response(JSON.stringify({ sync_state: rows, recent_logs: logs }), { headers: corsHeaders });
  }

  return new Response(JSON.stringify({ error: 'Unknown action' }), { status: 400, headers: corsHeaders });
}
