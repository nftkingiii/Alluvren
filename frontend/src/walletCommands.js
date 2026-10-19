// Daml commands an investor's wallet signs for its own records. Pure, so it
// can be tested without a wallet: wallet.js submits them through CIP-0103
// prepareExecute.

const PACKAGE = "#alluvren-v1";

// action -> [module, template, choice] for plain and sealed records.
const CHOICES = {
  acknowledge: {
    plain: ["Alluvren.Claims", "ClaimEntitlement", "ClaimEntitlement_Acknowledge"],
    sealed: ["Alluvren.Sealed", "PrivateEntitlement", "PrivateEntitlement_Acknowledge"],
  },
  withdraw: {
    plain: ["Alluvren.Claims", "OutstandingRedemption", "OutstandingRedemption_Withdraw"],
    sealed: ["Alluvren.Sealed", "PrivateOutstanding", "PrivateOutstanding_Withdraw"],
  },
};

export function walletCommand(action, record) {
  const kinds = CHOICES[action];
  if (!kinds) throw new Error(`Unknown wallet action: ${action}`);
  if (typeof record?.contractId !== "string" || record.contractId === "") throw new Error("A record contract ID is required");
  const [module, template, choice] = record.sealed ? kinds.sealed : kinds.plain;
  return {
    ExerciseCommand: {
      templateId: `${PACKAGE}:${module}:${template}`,
      contractId: record.contractId,
      choice,
      choiceArgument: {},
    },
  };
}

// The prepareExecute request for one action, acting only as the wallet party.
export function walletSubmission(action, record, party, now = Date.now()) {
  if (typeof party !== "string" || !party.includes("::")) throw new Error("A wallet party is required");
  return {
    commandId: `alluvren-${action}-${record.contractId.slice(0, 12)}-${now}`,
    actAs: [party],
    commands: [walletCommand(action, record)],
  };
}

// Before asking the wallet to sign, check the challenge is the sign-in text
// the backend issues for this wallet and this site, not something else.
export function isSignInChallenge(message, wallet, host) {
  if (typeof message !== "string") return false;
  const lines = message.split("\n");
  return lines.length === 4
    && lines[0] === `Sign in to Alluvren at ${host}`
    && lines[1] === `Wallet: ${wallet}`
    && /^Nonce: [0-9a-f]{32}$/.test(lines[2])
    && /^Expires: \d{4}-\d{2}-\d{2}T/.test(lines[3]);
}
