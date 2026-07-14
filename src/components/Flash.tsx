export default function Flash({ msg, err }: { msg?: string; err?: string }) {
  if (!msg && !err) return null;
  return (
    <>
      {err && <div className="alert error">{err}</div>}
      {msg && <div className="alert success">{msg}</div>}
    </>
  );
}
