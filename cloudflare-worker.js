export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Content-Type": "application/json",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: corsHeaders });

    try {
      const url = new URL(request.url);

      // GET /parking - all parking spaces
      if (request.method === "GET" && url.pathname === "/parking") {
        const { results } = await env.YES_PARKING.prepare(
          "SELECT * FROM parking_space"
        ).all();
        return json(results);
      }

      // POST /rfid - start or update a parking session when RFID is scanned
      if (request.method === "POST" && url.pathname === "/rfid") {
        const { space_id, rfid } = await request.json();
        if (!space_id || !rfid) {
          return json({ error: "space_id and rfid are required" }, 400);
        }

        const active = await env.YES_PARKING.prepare(
          "SELECT * FROM parking_session WHERE parking_space_id=? AND end_time IS NULL"
        ).bind(space_id).first();

        if (active && active.rfid_id === rfid) {
          return json({ message: "Already active", session: active });
        }

        if (active) {
          await env.YES_PARKING.prepare(
            "UPDATE parking_session SET end_time=datetime('now') WHERE parking_space_id=? AND end_time IS NULL"
          ).bind(space_id).run();
        }

        await env.YES_PARKING.prepare(
          "INSERT INTO parking_session (parking_space_id, start_time, rfid_id) VALUES (?, datetime('now'), ?)"
        ).bind(space_id, rfid).run();

        return json({ message: "Updated" });
      }

      // POST /exit - close the active session at a parking space
      if (request.method === "POST" && url.pathname === "/exit") {
        const { space_id, rfid } = await request.json();
        if (!space_id) return json({ error: "space_id is required" }, 400);

        const activeSession = await env.YES_PARKING.prepare(
          `SELECT * FROM parking_session
           WHERE parking_space_id=? AND end_time IS NULL${rfid ? " AND rfid_id=?" : ""}`
        ).bind(...(rfid ? [space_id, rfid] : [space_id])).first();

        if (!activeSession) return json({ error: "No matching active session found." }, 404);

        await env.YES_PARKING.prepare(
          "UPDATE parking_session SET end_time=datetime('now') WHERE parking_id=?"
        ).bind(activeSession.parking_id).run();

        const session = await env.YES_PARKING.prepare(
          "SELECT * FROM parking_session WHERE parking_id=?"
        ).bind(activeSession.parking_id).first();

        return json({ success: true, session });
      }

      // GET /sessions
      // GET /sessions?active=1
      // GET /sessions?active=1&rfid=4F7E9E4
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

        return json(results);
      }

      // POST /payments/confirm - mark one user's completed parking session as paid.
      // A payment gateway webhook should replace this self-confirmation before production.
      if (request.method === "POST" && url.pathname === "/payments/confirm") {
        const { parking_id, rfid } = await request.json();
        if (!parking_id || !rfid) {
          return json({ error: "parking_id and rfid are required" }, 400);
        }

        const session = await env.YES_PARKING.prepare(
          `SELECT parking_session.*, parking_space.price_per_hour,
             MAX(1, ROUND((julianday(parking_session.end_time) - julianday(parking_session.start_time)) * 1440)) AS elapsed_minutes
           FROM parking_session
           JOIN parking_space ON parking_space.parking_space_id = parking_session.parking_space_id
           WHERE parking_session.parking_id=? AND parking_session.rfid_id=?`
        ).bind(parking_id, rfid).first();

        if (!session) return json({ error: "Parking session not found." }, 404);
        if (!session.end_time) return json({ error: "Parking session has not ended." }, 409);
        if (Number(session.paid) === 1) return json({ success: true, already_paid: true });

        const amount = (Number(session.elapsed_minutes) / 60) * Number(session.price_per_hour);
        await env.YES_PARKING.batch([
          env.YES_PARKING.prepare(
            "UPDATE parking_session SET paid=1 WHERE parking_id=? AND rfid_id=? AND end_time IS NOT NULL"
          ).bind(parking_id, rfid),
          env.YES_PARKING.prepare(
            "INSERT INTO payment (parking_session_id, amount) VALUES (?, ?)"
          ).bind(parking_id, amount),
        ]);

        return json({ success: true, parking_id, amount });
      }

      // GET /users - user profiles (do not return passwords)
      if (request.method === "GET" && url.pathname === "/users") {
        const { results } = await env.YES_PARKING.prepare(
          "SELECT name, email, rfid_id, phone_number, vehicle_number FROM users"
        ).all();
        return json(results);
      }

      // POST /users - create a user
      if (request.method === "POST" && url.pathname === "/users") {
        const { name, email, password, rfid_id, phone_number = null, vehicle_number = null } = await request.json();
        if (!name || !email || !password || !rfid_id) {
          return json({ error: "name, email, password and rfid_id are required" }, 400);
        }

        await env.YES_PARKING.prepare(
          "INSERT INTO users (name, email, password, rfid_id, phone_number, vehicle_number) VALUES (?, ?, ?, ?, ?, ?)"
        ).bind(name, email, password, rfid_id, phone_number, vehicle_number).run();

        return json({ success: true }, 201);
      }

      // PUT /users/:rfid - update a user
      if (request.method === "PUT" && url.pathname.startsWith("/users/")) {
        const rfid = decodeURIComponent(url.pathname.slice("/users/".length));
        const { name, email, password, phone_number, vehicle_number } = await request.json();

        if (password) {
          await env.YES_PARKING.prepare(
            "UPDATE users SET name=?, email=?, password=?, phone_number=?, vehicle_number=? WHERE rfid_id=?"
          ).bind(name, email, password, phone_number, vehicle_number, rfid).run();
        } else {
          await env.YES_PARKING.prepare(
            "UPDATE users SET name=?, email=?, phone_number=?, vehicle_number=? WHERE rfid_id=?"
          ).bind(name, email, phone_number, vehicle_number, rfid).run();
        }

        return json({ success: true });
      }

      // DELETE /users/:rfid - delete a user
      if (request.method === "DELETE" && url.pathname.startsWith("/users/")) {
        const rfid = decodeURIComponent(url.pathname.slice("/users/".length));
        await env.YES_PARKING.prepare("DELETE FROM users WHERE rfid_id=?")
          .bind(rfid)
          .run();
        return json({ success: true });
      }

      // POST /auth/login - sign in with data in the users table
      if (request.method === "POST" && url.pathname === "/auth/login") {
        const { email, password } = await request.json();
        if (!email || !password) {
          return json({ error: "Email and password are required" }, 400);
        }

        const user = await env.YES_PARKING.prepare(
          "SELECT name, email, rfid_id, phone_number, vehicle_number, password FROM users WHERE email=?"
        ).bind(email).first();

        if (!user || user.password !== password) {
          return json({ error: "Invalid credentials" }, 401);
        }

        const token = btoa(JSON.stringify({
          email: user.email,
          name: user.name,
          exp: Date.now() + 86400000,
        }));

        return json({
          token,
          user: {
            name: user.name,
            email: user.email,
            rfid_id: user.rfid_id,
            phone_number: user.phone_number,
            vehicle_number: user.vehicle_number,
          },
        });
      }

      // POST /admit - register/admit a new user
      if (request.method === "POST" && url.pathname === "/admit") {
        const { name, email, password, rfid_id, phone_number, vehicle_number } = await request.json();
        if (!name || !email || !password || !rfid_id) {
          return json({ error: "name, email, password and rfid_id are required" }, 400);
        }

        const existing = await env.YES_PARKING.prepare(
          "SELECT rfid_id FROM users WHERE rfid_id=? OR email=?"
        ).bind(rfid_id, email).first();

        if (existing) {
          return json({ error: "RFID or email already exists" }, 409);
        }

        await env.YES_PARKING.prepare(
          "INSERT INTO users (name, email, password, rfid_id, phone_number, vehicle_number) VALUES (?, ?, ?, ?, ?, ?)"
        ).bind(name, email, password, rfid_id, phone_number ?? null, vehicle_number ?? null).run();

        return json({
          success: true,
          user: { name, email, rfid_id, phone_number, vehicle_number },
        }, 201);
      }

      return json({ error: "Not found" }, 404);
    } catch (error) {
      console.error(error);
      return json({ error: error.message || "Internal server error" }, 500);
    }
  },
};
