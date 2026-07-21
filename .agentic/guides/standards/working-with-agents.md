# Working With Agents — Planning & Collaboration

Process practices for how the human owner and the agent fleet collaborate. These
are *judgement* guides, not MUST/SHOULD code rules (those live in the domain guides
indexed by `PATTERNS.md`).

## 1. Plan in vertical slices, not horizontal phases

When planning multi-step work, prefer slices that cross **every layer** —
schema → logic → UI → i18n → test — for one thin user-visible capability, over
phases that complete one layer for the whole feature before starting the next.

- **Why:** a vertical slice is shippable and verifiable on its own; a horizontal
  phase (all migrations, then all the logic) hides integration risk until the end
  and produces nothing demoable mid-stream.
- **Anti-pattern:** "first I'll write all six migrations, then all the actions."

## 2. Prototype to explore; contract to ship

For design/approach exploration it is cheaper to generate several rough variants
and react to them than to specify one perfect version up front. Build, look,
discard, repeat.

- The moment work moves toward production it is governed by the project's locked
  artifacts and gates. Prototyping does **not** waive them — it feeds them: a
  variant you keep becomes a recorded decision, not an accidental standard.
- **Anti-pattern:** treating a throwaway prototype as shipped because it "looked
  done", skipping the gates.

## 3. Ask to be challenged, not babysat

When the owner is reasoning through a decision, default to **surfacing the strongest
objection** rather than agreeing and proceeding. "Grill me / push back" is the
expected mode, not insubordination.

- **Why:** a solo owner has no second reviewer in the room; the agent is the only
  adversarial check before the gates run. Performative agreement wastes that.
- **Here this is encoded structurally** — the `blind-code-reviewer` reviews the
  staged diff with **no** access to the author's reasoning precisely so it cannot
  be talked into agreement, and the read-only gates must emit a literal `PASS`.
  Extend the same stance to chat: name the risk, state the cheaper alternative,
  then proceed — don't bury a real objection to sound agreeable.
- **Anti-pattern:** "Great idea!" followed by silently implementing something you
  could see was going to fail a gate.

## 4. Escalate early, with options

When blocked on a judgment call the policy files reserve for humans
(`.agentic/guides/policy/escalation-policy.md`), stop and present the decision with
concrete options — not a status report that buries the question. The agent output
contract's `## Escalate to human` section exists exactly for this.
