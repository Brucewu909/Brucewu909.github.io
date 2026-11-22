(function () {
  const list = document.getElementById("trip-list");
  const trips = (typeof TRAVELS !== "undefined" ? TRAVELS : [])
    .slice()
    .sort((a, b) => (b.start || "").localeCompare(a.start || ""));

  if (trips.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No trips yet. Add one in travels-data.js.";
    list.appendChild(empty);
    return;
  }

  const fmt = (iso) =>
    new Date(iso + "T00:00:00").toLocaleDateString(undefined, {
      year: "numeric", month: "short", day: "numeric",
    });

  for (const trip of trips) {
    const card = document.createElement("article");
    card.className = "trip";

    const h2 = document.createElement("h2");
    h2.textContent = trip.place || "Untitled trip";
    card.appendChild(h2);

    if (trip.start) {
      const time = document.createElement("p");
      time.className = "dates";
      time.textContent = trip.end && trip.end !== trip.start
        ? `${fmt(trip.start)} – ${fmt(trip.end)}`
        : fmt(trip.start);
      card.appendChild(time);
    }

    if (trip.experiences && trip.experiences.length) {
      const ul = document.createElement("ul");
      for (const item of trip.experiences) {
        const li = document.createElement("li");
        li.textContent = item;
        ul.appendChild(li);
      }
      card.appendChild(ul);
    }

    if (trip.notes) {
      const notes = document.createElement("p");
      notes.className = "notes";
      notes.textContent = trip.notes;
      card.appendChild(notes);
    }

    list.appendChild(card);
  }
})();
