const API_URL = "https://yes-parking.pratyushgupta04.workers.dev";
const UPI_ID = "9693714522@pthdfc";
const UPI_PAYEE_NAME = "Yes Parking";
const spots = [];

const state = {
  user: null,
  activeSession: null,
  eventsInitialized: false,
  pollId: null,
  refreshInProgress: false,
  currentScreen: "home",
  currentSpot: null,
  parkingStart: null,
  timerId: null,
  history: [],
  notifications: [{ title: "Welcome", message: "Find and park in one tap.", time: new Date() }],
  map: null,
  markerLayer: null,
  userLocation: null,
  lastPayment: null,
  navigationActive: false,
  navRoute: null,
  navSimulationTimer: null,
  routingControl: null,
  userLocationMarker: null,
  watchId: null,
};

const screenIds = [
  "home",
  "details",
  "navigation",
  "active-parking",
  "payment",
  "history",
  "notifications",
  "profile",
];

const currency = (value) => `₹${Number(value).toFixed(2)}`;

function setAppAuthenticated(isAuthenticated) {
  document.getElementById("loginView").classList.toggle("hidden", isAuthenticated);
  document.querySelector(".app-shell").classList.toggle("hidden", !isAuthenticated);
}

function renderProfile() {
  const user = state.user;
  if (!user) return;
  document.getElementById("profileName").textContent = user.name || "-";
  document.getElementById("profileEmail").textContent = user.email || "-";
  document.getElementById("profileRfid").textContent = user.rfid_id || "-";
  document.getElementById("profileVehicle").textContent = user.vehicle_number || "Not added";
  document.getElementById("header-subtitle").textContent = `Welcome, ${user.name}`;
}

function formatDbDate(value) {
  if (!value) return "-";
  const date = new Date(value.replace(" ", "T") + "Z");
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function setSessionSummary(session) {
  const title = document.getElementById("sessionSummaryTitle");
  const text = document.getElementById("sessionSummaryText");
  const button = document.getElementById("viewSessionBtn");
  button.classList.toggle("hidden", !session);
  if (!session) {
    title.textContent = "No active parking session";
    text.textContent = "Your RFID is not currently checked in.";
    return;
  }
  const spot = getSpotById(`P-${session.parking_space_id}`);
  title.textContent = "Parking session active";
  text.textContent = `${spot?.id || `Space ${session.parking_space_id}`} since ${formatDbDate(session.start_time)}`;
}

async function login(email, password) {
  const response = await fetch(`${API_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Unable to sign in.");
  localStorage.setItem("yesParkingAuth", JSON.stringify(payload));
  state.user = payload.user;
}

async function refreshUserProfile() {
  if (!state.user?.email) return;
  const response = await fetch(`${API_URL}/users`);
  if (!response.ok) throw new Error("Could not refresh your profile.");
  const users = await response.json();
  const freshUser = users.find((user) => user.email === state.user.email);
  if (!freshUser) return;
  state.user = { ...state.user, ...freshUser };
  const savedAuth = JSON.parse(localStorage.getItem("yesParkingAuth") || "{}");
  localStorage.setItem("yesParkingAuth", JSON.stringify({ ...savedAuth, user: state.user }));
  renderProfile();
}

function logout() {
  if (state.pollId) clearInterval(state.pollId);
  state.pollId = null;
  localStorage.removeItem("yesParkingAuth");
  state.user = null;
  state.activeSession = null;
  setAppAuthenticated(false);
  document.getElementById("loginForm").reset();
}

function getSessionPayment(session) {
  const started = new Date(session.start_time.replace(" ", "T") + "Z");
  const ended = new Date(session.end_time.replace(" ", "T") + "Z");
  const elapsedMinutes = Math.max(1, Math.round((ended - started) / 60000));
  const spot = getSpotById(`P-${session.parking_space_id}`);
  const pricePerHour = Number(spot?.pricePerHour ?? 0);

  return {
    parkingId: session.parking_id,
    spaceId: session.parking_space_id,
    spotId: spot?.id || `Space ${session.parking_space_id}`,
    date: started,
    elapsedMinutes,
    total: (elapsedMinutes / 60) * pricePerHour,
    pricePerHour,
    paid: Number(session.paid) === 1,
  };
}

function hydrateActiveParking(session) {
  const spot = getSpotById(`P-${session.parking_space_id}`);
  state.currentSpot = spot || { id: `P-${session.parking_space_id}`, rawId: session.parking_space_id, pricePerHour: 0 };
  state.parkingStart = new Date(session.start_time.replace(" ", "T") + "Z");
  document.getElementById("activeSpot").textContent = state.currentSpot.id;
  document.getElementById("activeStartTime").textContent = formatDbDate(session.start_time);
  if (state.timerId) clearInterval(state.timerId);
  state.timerId = setInterval(updateParkingStats, 1000);
  updateParkingStats();
}

async function loadActiveSession() {
  if (!state.user?.rfid_id) return;
  const response = await fetch(`${API_URL}/sessions?active=1&rfid=${encodeURIComponent(state.user.rfid_id)}`);
  if (!response.ok) throw new Error("Could not check your parking status.");
  const sessions = await response.json();
  state.activeSession = sessions.find((session) => session.rfid_id === state.user.rfid_id) || null;
  setSessionSummary(state.activeSession);
  if (state.activeSession) hydrateActiveParking(state.activeSession);
}

async function loadParkingHistory() {
  if (!state.user?.rfid_id) return;
  const response = await fetch(`${API_URL}/sessions?rfid=${encodeURIComponent(state.user.rfid_id)}`);
  if (!response.ok) throw new Error("Could not load your parking history.");
  const sessions = await response.json();
  const rfidSessions = sessions.filter((session) => session.rfid_id === state.user.rfid_id);

  state.history = rfidSessions
    .filter((session) => session.end_time)
    .map((session) => ({ ...session, ...getSessionPayment(session) }));
  renderHistory();
}

function getStatusFromOccupancy(occupancyStatus) {
  if (occupancyStatus === 1) return "Occupied";
  if (occupancyStatus === 2) return "Paid";
  return "Free";
}

function getStatusColor(status) {
  if (status === "Occupied") return "#ef4444";
  if (status === "Paid") return "#2563eb";
  return "#16a34a";
}

function calculateDistanceKm(lat1, lon1, lat2, lon2) {
  const toRad = (v) => (v * Math.PI) / 180;
  const r = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return r * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function getReferenceLocation() {
  return state.userLocation ?? { lat: 12.9716, lon: 77.5946 };
}

function buildSpotFromApi(row) {
  const ref = getReferenceLocation();
  return {
    id: `P-${row.parking_space_id}`,
    rawId: row.parking_space_id,
    status: getStatusFromOccupancy(Number(row.occupancy_status ?? 0)),
    pricePerHour: Number(row.price_per_hour ?? 0),
    distanceKm: Number(calculateDistanceKm(ref.lat, ref.lon, Number(row.lat), Number(row.lon)).toFixed(2)),
    sensor: "Online",
    lat: Number(row.lat),
    lon: Number(row.lon),
    occupancyStatus: Number(row.occupancy_status ?? 0),
  };
}

function showScreen(id) {
  moveMapToScreen(id);
  screenIds.forEach((screenId) => {
    document.getElementById(screenId).classList.toggle("active", screenId === id);
  });
  document.querySelectorAll(".nav-link").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.target === id);
  });
  state.currentScreen = id;
  requestAnimationFrame(() => state.map?.invalidateSize());
}

function moveMapToScreen(screenId) {
  const mapWrapper = document.querySelector(".mock-map");
  const destination = document.getElementById(
    screenId === "navigation" ? "navigationMap" : "mapHomeSlot"
  );

  if (mapWrapper && destination && mapWrapper.parentElement !== destination) {
    destination.appendChild(mapWrapper);
  }
}

function getSpotById(id) {
  return spots.find((spot) => spot.id === id);
}

function renderSpotList(data = spots) {
  const container = document.getElementById("spotList");
  container.innerHTML = "";
  if (data.length === 0) {
    container.innerHTML = '<div class="list-item"><strong>No spots found</strong></div>';
    return;
  }
  data.forEach((spot) => {
    const row = document.createElement("button");
    row.className = "list-item";
    row.innerHTML = `<strong>${spot.id}</strong><p>${spot.status} • ${currency(
      spot.pricePerHour
    )}/hr • ${spot.distanceKm} km</p>`;
    row.addEventListener("click", () => startDirectNavigation(spot.id));
    container.appendChild(row);
  });
}

function openSpotDetails(spotId) {
  const spot = getSpotById(spotId);
  if (!spot) return;
  state.currentSpot = spot;
  document.getElementById("detailSpotId").textContent = `${spot.id} (DB: ${spot.rawId})`;
  document.getElementById("detailStatus").textContent = spot.status;
  document.getElementById("detailPrice").textContent = `${currency(spot.pricePerHour)} / hour`;
  document.getElementById("detailDistance").textContent = `${spot.distanceKm} km`;
  document.getElementById("detailSensor").textContent = `${spot.sensor} (occupancy: ${spot.occupancyStatus})`;
  showScreen("details");
}

function startDirectNavigation(spotId) {
  const spot = getSpotById(spotId);

  if (!spot) return;

  state.currentSpot = spot;
  state.navigationActive = true;
  document.getElementById("navSpotId").textContent = spot.id;

  if (!state.userLocation) {
    if (!navigator.geolocation) {
      state.navigationActive = false;
      addNotification("Location unavailable", "Geolocation is not supported.");
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const { latitude: lat, longitude: lon } = position.coords;
        state.userLocation = { lat, lon };

        if (state.userLocationMarker) {
          state.userLocationMarker.setLatLng([lat, lon]);
        } else {
          state.userLocationMarker = L.marker([lat, lon])
            .addTo(state.map)
            .bindPopup("You are here");
        }

        spots.forEach((parkingSpot) => {
          parkingSpot.distanceKm = Number(
            calculateDistanceKm(lat, lon, parkingSpot.lat, parkingSpot.lon).toFixed(2)
          );
        });
        renderSpotList();
        drawNavigationRoute();
        showScreen("navigation");
      },
      () => {
        state.navigationActive = false;
        addNotification("Location error", "Unable to get your current location.");
      },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 10000 }
    );
    return;
  }

  drawNavigationRoute();
  showScreen("navigation");
}

function drawNavigationRoute() {
  if (!state.userLocation || !state.currentSpot || !state.map) return;

  // Remove old route
  if (state.routingControl) {
    state.map.removeControl(state.routingControl);
    state.routingControl = null;
  }

  state.routingControl = L.Routing.control({
    waypoints: [
      L.latLng(state.userLocation.lat, state.userLocation.lon),
      L.latLng(state.currentSpot.lat, state.currentSpot.lon),
    ],
    routeWhileDragging: false,
    addWaypoints: false,
    draggableWaypoints: false,
    fitSelectedRoutes: true,
    show: false,
    lineOptions: {
      styles: [{ color: "#2563eb", weight: 5, opacity: 0.8 }],
    },
    createMarker: (i, wp) => {
      if (i === 0) {
        return L.marker(wp.latLng).bindPopup("Your location");
      }
      return L.marker(wp.latLng).bindPopup(state.currentSpot.id);
    },
  })
    .on("routesfound", (e) => {
      const route = e.routes[0];
      const distanceKm = (route.summary.totalDistance / 1000).toFixed(1);
      const etaMin = Math.ceil(route.summary.totalTime / 60);

      document.getElementById("navEta").textContent = `${etaMin} mins`;
      document.getElementById("navDistance").textContent = `${distanceKm} km`;
      document.getElementById("navStatus").textContent =
        `${state.currentSpot.status} • ${distanceKm} km`;
    })
    .addTo(state.map);
}

function startLiveNavigation() {
  if (!state.currentSpot) return;

  addNotification(
    "Navigation started",
    `Following route to ${state.currentSpot.id}`
  );
}

function cancelNavigation() {
  state.navigationActive = false;

  if (state.routingControl) {
    state.map.removeControl(state.routingControl);
    state.routingControl = null;
  }

  addNotification("Navigation cancelled", "Returned to the parking map.");
  showScreen("home");

  // Center back on user if available
  if (state.userLocation) {
    state.map.setView([state.userLocation.lat, state.userLocation.lon], 15);
  }
}

function openNavigation() {
  if (!state.currentSpot) return;
  document.getElementById("navSpotId").textContent = state.currentSpot.id;
  document.getElementById("navEta").textContent = `${Math.ceil(state.currentSpot.distanceKm * 6)} mins`;
  document.getElementById("navStatus").textContent = state.currentSpot.status;
  showScreen("navigation");
}

function addNotification(title, message) {
  state.notifications.unshift({ title, message, time: new Date() });
  renderNotifications();
}

function initializeMap() {
  if (state.map) return;
  state.map = L.map("map").setView([12.9716, 77.5946], 12);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(state.map);
  state.markerLayer = L.layerGroup().addTo(state.map);

}

function renderMapMarkers(data = spots) {
  if (!state.map || !state.markerLayer) return;

  state.markerLayer.clearLayers();
  const bounds = [];

  data.forEach((spot) => {
    const marker = L.circleMarker([spot.lat, spot.lon], {
      radius: 9,
      color: "#ffffff",
      weight: 2,
      fillColor: getStatusColor(spot.status),
      fillOpacity: 0.95,
    }).addTo(state.markerLayer);

    marker.on("click", () => startDirectNavigation(spot.id));

    bounds.push([spot.lat, spot.lon]);
  });

  if (bounds.length > 0) {
    state.map.fitBounds(bounds, { padding: [24, 24], maxZoom: 14 });
  }
}

async function fetchSpotsFromCloudflare(silent = false) {
  try {
    const response = await fetch(`${API_URL}/parking`);
    if (!response.ok) throw new Error(`Request failed (${response.status})`);
    const rows = await response.json();
    spots.length = 0;
    rows.forEach((row) => {
      const lat = Number(row.lat);
      const lon = Number(row.lon);
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        spots.push(buildSpotFromApi(row));
      }
    });
    renderSpotList();
    renderMapMarkers();
    await refreshUserProfile();
    await loadActiveSession();
    await loadParkingHistory();
    if (!silent) addNotification("Live spots loaded", `${spots.length} spots synced from Cloudflare D1.`);
  } catch (error) {
    if (!silent) addNotification("Live data error", "Could not load parking spots from API.");
  }
}

async function refreshLiveData() {
  if (!state.user || state.refreshInProgress) return;
  state.refreshInProgress = true;
  try {
    await fetchSpotsFromCloudflare(true);
  } finally {
    state.refreshInProgress = false;
  }
}

function startLiveUpdates() {
  if (state.pollId) clearInterval(state.pollId);
  state.pollId = setInterval(refreshLiveData, 15000);
}

function startParkingSession() {
  if (!state.currentSpot) return;

  if (state.navSimulationTimer) {
    clearInterval(state.navSimulationTimer);
    state.navSimulationTimer = null;
  }

  state.parkingStart = new Date();
  document.getElementById("activeSpot").textContent = state.currentSpot.id;
  document.getElementById("activeStartTime").textContent = state.parkingStart.toLocaleTimeString();
  showScreen("active-parking");
  addNotification("Parking started", `Session active at spot ${state.currentSpot.id}`);
  if (state.timerId) clearInterval(state.timerId);
  state.timerId = setInterval(updateParkingStats, 1000);
  updateParkingStats();
}

function updateParkingStats() {
  if (!state.parkingStart || !state.currentSpot) return;
  const elapsedMs = Date.now() - state.parkingStart.getTime();
  const hours = elapsedMs / 3600000;
  const cost = hours * state.currentSpot.pricePerHour;
  const totalSeconds = Math.floor(elapsedMs / 1000);
  const hh = String(Math.floor(totalSeconds / 3600)).padStart(2, "0");
  const mm = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, "0");
  const ss = String(totalSeconds % 60).padStart(2, "0");
  document.getElementById("activeElapsed").textContent = `${hh}:${mm}:${ss}`;
  document.getElementById("activeCost").textContent = currency(cost);
}

async function endParkingSession() {
  if (!state.parkingStart || !state.currentSpot) return;
  const button = document.getElementById("endParkingBtn");
  button.disabled = true;
  button.textContent = "Ending…";

  try {
    const response = await fetch(`${API_URL}/exit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ space_id: state.currentSpot.rawId, rfid: state.user?.rfid_id }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Could not end the parking session.");

    if (state.timerId) clearInterval(state.timerId);
    state.timerId = null;
    state.activeSession = null;
    setSessionSummary(null);
    openPaymentForSession(payload.session);
  } catch (error) {
    addNotification("Unable to end parking", error.message);
  } finally {
    button.disabled = false;
    button.textContent = "End Parking";
  }
}

function openPaymentForSession(session) {
  const payment = getSessionPayment(session);
  const paymentReference = `YESP${payment.parkingId}${Date.now()}`;
  document.getElementById("payTime").textContent = `${payment.elapsedMinutes} min`;
  document.getElementById("payRate").textContent = `${currency(payment.pricePerHour)} / hour`;
  document.getElementById("payBase").textContent = currency(payment.total);
  document.getElementById("payTotal").textContent = currency(payment.total);
  document.getElementById("upiId").textContent = UPI_ID;
  document.getElementById("confirmPaymentBtn").disabled = true;
  document.getElementById("upiAppSelect").value = "";
  document.getElementById("payNowBtn").disabled = true;
  state.lastPayment = {
    ...payment,
    paymentReference,
  };
  addNotification("Payment due", `${currency(payment.total)} is due for ${payment.spotId}.`);
  showScreen("payment");
}

function getUpiPaymentUrl(payment) {
  const params = new URLSearchParams({
    pa: UPI_ID,
    pn: UPI_PAYEE_NAME,
    am: payment.total.toFixed(2),
    cu: "INR",
    tn: `Parking ${payment.spotId}`,
    tr: payment.paymentReference,
  });
  return `upi://pay?${params.toString()}`;
}

function openUpiPayment(appPackage = null) {
  if (!state.lastPayment) return;
  document.getElementById("confirmPaymentBtn").disabled = false;
  const upiUrl = getUpiPaymentUrl(state.lastPayment);
  const isAndroid = /Android/i.test(navigator.userAgent);

  if (appPackage && isAndroid) {
    const intentUrl = `intent://pay?${upiUrl.split("?")[1]}#Intent;scheme=upi;package=${appPackage};end`;
    window.location.href = intentUrl;
    return;
  }

  window.location.href = upiUrl;
}

async function completePayment() {
  if (!state.lastPayment) return;
  const confirmButton = document.getElementById("confirmPaymentBtn");
  confirmButton.disabled = true;
  confirmButton.textContent = "Confirming…";

  try {
    const response = await fetch(`${API_URL}/payments/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parking_id: state.lastPayment.parkingId, rfid: state.user?.rfid_id }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Could not record the payment.");

    const completedPayment = state.lastPayment;
    addNotification(
      "Payment recorded",
      `UPI payment of ${currency(completedPayment.total)} recorded for ${completedPayment.spotId}.`
    );
    state.parkingStart = null;
    state.timerId = null;
    state.lastPayment = null;
    await loadParkingHistory();
    showScreen("history");
  } catch (error) {
    addNotification("Payment not recorded", error.message);
    confirmButton.disabled = false;
  } finally {
    confirmButton.textContent = "I've paid";
  }
}

function renderHistory() {
  const historyList = document.getElementById("historyList");
  historyList.innerHTML = "";
  if (state.history.length === 0) {
    historyList.innerHTML = '<div class="list-item"><strong>No sessions yet</strong></div>';
    return;
  }
  state.history.forEach((entry) => {
    const item = document.createElement("div");
    item.className = "list-item";
    const paymentStatus = entry.paid ? "Paid" : "Payment due";
    item.innerHTML = `
      <strong>${entry.spotId}</strong>
      <p>${entry.date.toLocaleString()} • ${entry.elapsedMinutes} min</p>
      <p>${currency(entry.total)} at ${currency(entry.pricePerHour)}/hr • <span class="payment-status ${entry.paid ? "is-paid" : "is-due"}">${paymentStatus}</span></p>
      ${entry.paid ? "" : `<button class="btn pay-session-btn" type="button" data-parking-id="${entry.parkingId}">Pay ${currency(entry.total)}</button>`}
    `;
    historyList.appendChild(item);
  });
}

function renderNotifications() {
  const list = document.getElementById("notificationList");
  list.innerHTML = "";
  state.notifications.forEach((note) => {
    const item = document.createElement("div");
    item.className = "list-item";
    item.innerHTML = `<strong>${note.title}</strong><p>${note.message}</p><p>${note.time.toLocaleString()}</p>`;
    list.appendChild(item);
  });
}

function initializeEvents() {
  document.querySelectorAll(".nav-link").forEach((btn) => {
    btn.addEventListener("click", () => showScreen(btn.dataset.target));
  });

  document.getElementById("navigateBtn").addEventListener("click", () => {
    if (!state.userLocation) {
      addNotification("Location needed", "Enable location to navigate.");
      return;
    }
    if (state.currentSpot) {
      startDirectNavigation(state.currentSpot.id);
    }
  });

  document.getElementById("startNavBtn").addEventListener("click", startLiveNavigation);

  document.getElementById("cancelNavBtn").addEventListener("click", cancelNavigation);

  document.getElementById("myParkingQuickBtn").addEventListener("click", () => {
    if (state.parkingStart) showScreen("active-parking");
    else showScreen("history");
  });

  document.getElementById("viewSessionBtn").addEventListener("click", () => {
    if (state.activeSession) showScreen("active-parking");
  });
  document.getElementById("logoutBtn").addEventListener("click", logout);

  document.getElementById("endParkingBtn").addEventListener("click", endParkingSession);
  document.getElementById("extendTimeBtn").addEventListener("click", () => {
    addNotification("Time extended", "Parking session extension requested.");
  });
  document.getElementById("upiAppSelect").addEventListener("change", (event) => {
    document.getElementById("payNowBtn").disabled = !event.target.value;
  });
  document.getElementById("payNowBtn").addEventListener("click", () => {
    const selectedApp = document.getElementById("upiAppSelect").value;
    openUpiPayment(selectedApp === "generic" ? null : selectedApp);
  });
  document.getElementById("confirmPaymentBtn").addEventListener("click", completePayment);
  document.getElementById("historyList").addEventListener("click", (event) => {
    const button = event.target.closest(".pay-session-btn");
    if (!button) return;
    const payment = state.history.find((entry) => entry.parkingId === Number(button.dataset.parkingId));
    if (payment) openPaymentForSession(payment);
  });

  function startLocationTracking() {
    if (!navigator.geolocation) {
      addNotification("Location unavailable", "Geolocation is not supported.");
      return;
    }

    // Prevent multiple watchers
    if (state.watchId) {
      navigator.geolocation.clearWatch(state.watchId);
    }

    state.watchId = navigator.geolocation.watchPosition(
      (position) => {
        const lat = position.coords.latitude;
        const lon = position.coords.longitude;

        state.userLocation = { lat, lon };

        // Update or create user marker
        if (state.userLocationMarker) {
          state.userLocationMarker.setLatLng([lat, lon]);
        } else {
          state.userLocationMarker = L.marker([lat, lon])
            .addTo(state.map)
            .bindPopup("You are here");
        }

        // Recalculate distance to all parking spots
        spots.forEach((spot) => {
          spot.distanceKm = Number(
            calculateDistanceKm(lat, lon, spot.lat, spot.lon).toFixed(2)
          );
        });

        // Update list
        renderSpotList();

        // Update route if navigation is active
        if (state.navigationActive && state.currentSpot) {
          drawNavigationRoute();
        }

        // Keep map centered on user when not navigating
        if (!state.navigationActive) {
          state.map.setView([lat, lon], 15);
        }
      },
      (error) => {
        console.error(error);
        addNotification(
          "Location error",
          "Unable to get your current location."
        );
      },
      {
        enableHighAccuracy: true,
        maximumAge: 1000,
        timeout: 10000,
      }
    );
  }

  document.getElementById("locateBtn").addEventListener("click", startLocationTracking);

  document.getElementById("filterBtn").addEventListener("click", () => {
    const availableOnly = spots.filter((spot) => spot.status === "Free");
    renderSpotList(availableOnly);
    renderMapMarkers(availableOnly);
    document.getElementById("spotList").classList.remove("hidden");
  });

  document.getElementById("toggleViewBtn").addEventListener("click", (event) => {
    const list = document.getElementById("spotList");
    list.classList.toggle("hidden");
    event.target.textContent = list.classList.contains("hidden") ? "View List" : "View Map";
    if (list.classList.contains("hidden")) renderMapMarkers(spots);
  });

  document.getElementById("searchInput").addEventListener("input", (event) => {
    const value = event.target.value.trim().toLowerCase();
    const filtered = spots.filter(
      (spot) =>
        spot.id.toLowerCase().includes(value) ||
        String(spot.rawId).includes(value) ||
        spot.status.toLowerCase().includes(value)
    );
    renderSpotList(filtered);
    renderMapMarkers(filtered);
    document.getElementById("spotList").classList.remove("hidden");
  });

  document.getElementById("reserveBtn").addEventListener("click", () => {
    addNotification("Spot reserved", `Spot ${state.currentSpot?.id ?? ""} reserved successfully.`);
  });

  document.getElementById("saveSpotBtn").addEventListener("click", () => {
    addNotification("Saved", `Spot ${state.currentSpot?.id ?? ""} added to favorites.`);
  });
}

async function init() {
  const savedAuth = localStorage.getItem("yesParkingAuth");
  if (!savedAuth) {
    setAppAuthenticated(false);
    document.getElementById("loginForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      const error = document.getElementById("loginError");
      const button = document.getElementById("loginBtn");
      error.textContent = "";
      button.disabled = true;
      button.textContent = "Signing in…";
      try {
        await login(document.getElementById("loginEmail").value.trim(), document.getElementById("loginPassword").value);
        setAppAuthenticated(true);
        renderProfile();
        await startApp();
      } catch (loginError) {
        error.textContent = loginError.message;
      } finally {
        button.disabled = false;
        button.textContent = "Sign in";
      }
    });
    return;
  }
  try {
    state.user = JSON.parse(savedAuth).user;
    setAppAuthenticated(true);
    renderProfile();
    await startApp();
  } catch {
    logout();
  }
}

async function startApp() {
  initializeMap();
  renderSpotList();
  renderHistory();
  renderNotifications();
  if (!state.eventsInitialized) {
    initializeEvents();
    state.eventsInitialized = true;
  }
  await fetchSpotsFromCloudflare();
  startLiveUpdates();
}

init();
