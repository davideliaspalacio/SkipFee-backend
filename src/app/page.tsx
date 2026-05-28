export default function Home() {
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 32, maxWidth: 720 }}>
      <h1>Bros and Subs — Backend</h1>
      <p>
        API y webhook receiver para el panel admin. El frontend vive en{' '}
        <code>../frontend</code>.
      </p>
      <ul>
        <li>
          <code>GET /api/health</code> — healthcheck
        </li>
        <li>
          <code>POST /api/webhooks/kapso</code> — receptor de eventos de Kapso (HMAC SHA256)
        </li>
      </ul>
      <p style={{ marginTop: 24, opacity: 0.7 }}>
        Ver <code>PLAN.md</code> para el roadmap.
      </p>
    </main>
  );
}
