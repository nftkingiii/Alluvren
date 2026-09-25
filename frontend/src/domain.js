export const investors = [
  {
    id: "REQ-001",
    name: "Aster Capital",
    initials: "AC",
    units: 60000,
    seq: 1,
    received: "09:12",
    avatarStyle: "aster",
  },
  {
    id: "REQ-002",
    name: "Meridian Partners",
    initials: "MP",
    units: 30000,
    seq: 2,
    received: "09:26",
    avatarStyle: "meridian",
  },
  {
    id: "REQ-003",
    name: "Elm Family Office",
    initials: "EF",
    units: 10000,
    seq: 3,
    received: "09:41",
    avatarStyle: "elm",
  },
];

// Integer largest-remainder allocation. This is a demo preview, not ledger authority.
export function allocate(requests, liquidity) {
  if (
    !Number.isSafeInteger(liquidity) ||
    liquidity < 0 ||
    liquidity > 1e9 ||
    requests.length > 100
  )
    throw new Error("Invalid liquidity or request count");
  if (
    new Set(requests.map((r) => r.id)).size !== requests.length ||
    new Set(requests.map((r) => r.seq)).size !== requests.length
  )
    throw new Error("Duplicate request");
  if (
    requests.some(
      (r) =>
        !Number.isSafeInteger(r.units) ||
        r.units <= 0 ||
        r.units > 1e9 ||
        !Number.isSafeInteger(r.seq),
    )
  )
    throw new Error("Invalid request");
  const total = requests.reduce((s, r) => s + BigInt(r.units), 0n);
  if (!total) return [];
  const amount = BigInt(liquidity) < total ? BigInt(liquidity) : total;
  const rows = requests.map((r) => ({
    ...r,
    allocated: Number((amount * BigInt(r.units)) / total),
    remainder: (amount * BigInt(r.units)) % total,
  }));
  let spare = Number(amount) - rows.reduce((s, r) => s + r.allocated, 0);
  const ranked = [...rows].sort((a, b) =>
    a.remainder === b.remainder
      ? a.seq - b.seq
      : a.remainder > b.remainder
        ? -1
        : 1,
  );
  for (let i = 0; i < spare; i++) ranked[i].allocated++;
  return rows.map(({ remainder, ...r }) => ({
    ...r,
    outstanding: r.units - r.allocated,
  }));
}

export function initialState() {
  return {
    versions: [
      {
        version: 1,
        liquidity: 50000,
        approvals: [],
        confirmations: [],
        executed: false,
        claimed: [],
        created: "10:00",
      },
    ],
    active: 1,
    events: [
      {
        id: "seed-freeze",
        title: "Batch 01 frozen",
        detail: "3 requests bound to version 1. Demo reserve: 50,000 units.",
        time: "10:00",
        type: "batch",
        actor: "Fund operations",
        version: 1,
      },
      {
        id: "seed-open",
        title: "Redemption window closed",
        detail: "100,000 requested units across 3 investors.",
        time: "09:45",
        type: "request",
        actor: "Window administrator",
        version: 1,
      },
    ],
  };
}
export function canExecute(state, version) {
  const batch = state.versions.find((b) => b.version === version);
  return Boolean(
    batch &&
      state.active === version &&
      !batch.executed &&
      batch.approvals.includes("fund") &&
      batch.approvals.includes("treasury") &&
      new Set(batch.confirmations).size >= 2,
  );
}
export function transition(state, action) {
  const current = state.versions.find((b) => b.version === state.active);
  let next = structuredClone(state);
  let batch = next.versions.find((b) => b.version === action.version);
  let title;
  let detail;
  if (action.type === "replace") {
    if (current.executed)
      throw new Error("A finalized batch cannot be replaced");
    if (
      !Number.isSafeInteger(action.liquidity) ||
      action.liquidity < 0 ||
      action.liquidity > 100000 ||
      action.liquidity === current.liquidity
    )
      throw new Error("Choose a different reserve between 0 and 100,000");
    next.active++;
    next.versions.push({
      version: next.active,
      liquidity: action.liquidity,
      approvals: [],
      confirmations: [],
      executed: false,
      claimed: [],
      created: action.time,
    });
    title = `Batch version ${next.active} created`;
    detail = `Reserve changed from ${current.liquidity.toLocaleString()} to ${action.liquidity.toLocaleString()} units. Fresh approvals required.`;
  } else {
    if (!batch || action.version !== state.active)
      throw new Error("Stale batch blocked. Review the current version.");
    if (action.type === "approve") {
      if (
        batch.executed ||
        !["fund", "treasury"].includes(action.role) ||
        batch.approvals.includes(action.role)
      )
        throw new Error("Approval unavailable");
      batch.approvals.push(action.role);
      title = `${action.role === "fund" ? "Fund" : "Treasury"} review approved`;
      detail = `Demo approval bound to batch version ${batch.version}.`;
    } else if (action.type === "confirm") {
      if (
        batch.executed ||
        batch.approvals.length !== 2 ||
        !["A", "B", "C"].includes(action.member) ||
        batch.confirmations.includes(action.member)
      )
        throw new Error("Confirmation unavailable");
      batch.confirmations.push(action.member);
      title = `Member ${action.member} confirmed`;
      detail = `Demo BitSafe confirmation for version ${batch.version}.`;
    } else if (action.type === "execute") {
      if (!canExecute(state, action.version))
        throw new Error(
          "Both business approvals and two member confirmations are required",
        );
      batch.executed = true;
      batch.finalizedAt = action.time;
      title = "Batch finalized in demo";
      detail = `Version ${batch.version} consumed once. No asset transfer occurred.`;
    } else if (action.type === "claim") {
      if (
        !batch.executed ||
        batch.claimed.includes(action.investor) ||
        !allocate(investors, batch.liquidity).some(
          (r) => r.id === action.investor && r.allocated > 0,
        )
      )
        throw new Error("Acknowledgment unavailable");
      batch.claimed.push(action.investor);
      title = "Allocation acknowledged";
      detail = `${action.investor}, version ${batch.version}. Demo receipt only; not a payment.`;
    } else throw new Error("Unknown action");
  }
  const actor =
    action.type === "approve"
      ? action.role === "fund"
        ? "Maya Chen · Fund reviewer"
        : "Daniel Reed · Treasury reviewer"
      : action.type === "confirm"
        ? `Member ${action.member}`
        : action.type === "claim"
          ? investors.find((investor) => investor.id === action.investor)?.name || "Investor"
          : "Fund operations";
  next.events.unshift({
    id: action.id,
    title,
    detail,
    time: action.time,
    type: action.type,
    actor,
    version: action.type === "replace" ? next.active : action.version,
  });
  return next;
}
