// Prints a scrypt hash for accounts.json. Reads the password from stdin so it
// never lands in shell history or process listings.
//   node scripts/hash-password.mjs    (then type the password and press Enter)
import { createInterface } from "node:readline";
import { hashPassword } from "../src/auth.mjs";

const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: false });
process.stderr.write("Password: ");
rl.once("line", async (password) => {
  rl.close();
  if (password.length < 12) {
    process.stderr.write("\nUse at least 12 characters.\n");
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${await hashPassword(password)}\n`);
});
