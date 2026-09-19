# XEVEN Unified Brain — RLHF Training Pipeline

**Framework:** `rkinas/reasoning_models_how_to` — Research notes on LLM training + RLHF (PPO/DPO/GRPO/KTO)

**Architecture:** One unified agent brain that learns role PATTERNS from training data rather than constrained role-switching.
No `ROLE:` labels, no role-switching. Agent assesses each conversation situation and activates most effective learned pattern combination fluidly.

## 6 Learned Patterns (not prompts)

| Pattern | Learned Behavior | Training Signal | Reward Weight |
|---------|------------------|-----------------|---------------|
| `customer_support` | empathy + actionable solutions + follow-up check | Real support chats where empathy+solution+check => high satisfaction | task 0.4 / sat 0.4 / acc 0.2 (2400 ex) |
| `sales` | value demonstration + natural close cues + need assessment | Successful sales where value+close+needs => conversion | 0.5 / 0.3 / 0.2 (3100) |
| `shopping_assistant` | relevant options + comparison framing + needs assessment | Shopping sessions where options+comparison+needs => purchase | 0.4 / 0.35 / 0.25 (2800) |
| `product_advisor` | accurate specs + comparisons + limitation transparency | Product Q&A where accuracy+comparison+transparency => trust | 0.3 / 0.3 / 0.4 (2100) |
| `lead_qualification` | progressive qualification questions before offerings | Qualification chats where questions before offer => qualified lead | 0.45 / 0.25 / 0.3 (1900) |
| `general_assistant` | broadly-adaptive, draws on all patterns situationally | Meta-pattern for ambiguous situations, largest dataset | 0.33 / 0.33 / 0.34 (5200) |

**Total training conversations: ~18,500**

## Reward Function (NOT role-adherence)

```js
reward = w_task * taskCompletion + w_sat * userSatisfaction + w_acc * knowledgeAccuracy
// Role-adherence is NOT rewarded. Only outcomes.
```

- `taskCompletion`: Did conversation achieve user's goal? (booking created, question answered, lead qualified)
- `userSatisfaction`: Implicit (follow-up, sentiment, re-engagement) + explicit (thumbs up)
- `knowledgeAccuracy`: Grounded in `RELEVANT BUSINESS KNOWLEDGE` — no hallucination, cited correctly

See `reward.js`.

## Training Pipeline (rkinas framework)

1. **SFT** — Supervised fine-tuning on representative conversations for each pattern (real chat logs, simulated scenarios)
2. **Reward Model** — Train on human preference pairs: effective pattern vs ineffective for same situation
3. **RLHF** — PPO/DPO/GRPO on top of SFT with custom reward (see `trainer.js`)
   - `minimal_implementation/dpo_trainer.py` from rkinas is basis for DPO
   - GRPO for verifiable rewards (task completion is verifiable via booking DB, knowledge citation)
   - PPO for satisfaction (human feedback)

4. **Inference** — `brain.js` `assessSituation()` activates patterns situationally, no role labels. One brain.

## Usage

```bash
# Train (requires OPENAI_API_KEY or local model)
node training/trainer.js --method dpo --patterns all --epochs 3
node training/trainer.js --method grpo --reward taskCompletion

# Evaluate
node training/evaluate.js --pattern customer_support

# Inference is already live: server/src/core/agent/brain.js is used by chat/service.js
```

## Files

- `reward.js` — Reward function (task/satisfaction/accuracy)
- `dataset.js` — 6 pattern datasets (representative conversations)
- `trainer.js` — DPO/PPO/GRPO trainer (rkinas minimal_implementation)
- `config.js` — Training hyperparams
- `brain.js` — Pattern learning (situation -> pattern association)

## Result

One brain with learned expertise across 6 domains, adapts to each unique conversation. No `ROLE:` switching, no prompt constraints. Effectiveness measured by outcomes, not role adherence.

Reference: https://github.com/rkinas/reasoning_models_how_to
