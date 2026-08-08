# Cloudflare Worker changes

Replace the current `GET /sessions` route with this version. It allows the app to request the active session for one RFID instead of receiving every user's session.

```js
if (request.method === "GET" && url.pathname === "/sessions") {
  const activeOnly = url.searchParams.get("active") === "1";
  const rfid = url.searchParams.get("rfid");
  let sql = activeOnly
    ? "SELECT * FROM parking_session WHERE end_time IS NULL"
    : "SELECT * FROM parking_session WHERE 1=1";
  const params = [];
  if (rfid) {
    sql += " AND rfid_id=?";
    params.push(rfid);
  }
  sql += " ORDER BY start_time DESC";
  const statement = env.YES_PARKING.prepare(sql);
  const { results } = params.length
    ? await statement.bind(...params).all()
    : await statement.all();
  return Response.json(results, { headers: corsHeaders });
}
```

Update the login query to select `phone_number, vehicle_number` too, then include those fields in the returned `user` object. The profile screen will display the vehicle automatically when present.

## Production security

The provided Worker compares plaintext passwords and returns an unsigned Base64 token. Before a public launch, use a password hash and a signed, verified session token. The session endpoint should also authenticate the caller before accepting an RFID filter.
