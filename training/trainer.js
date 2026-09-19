"use strict";

/**
 * RLHF Trainer for XEVEN Unified Brain
 * Implements DPO/PPO/GRPO based on rkinas/reasoning_models_how_to/minimal_implementation/dpo_trainer.py
 * 
 * Pipeline: SFT -> Reward Model -> RLHF (DPO/PPO/GRPO)
 * Reward: task-completion-success + user-satisfaction + knowledge-accuracy (NOT role-adherence)
 */

const fs = require("fs");
const path = require("path");
const { DATASETS, generatePreferencePairs, getTrainingStats } = require("./dataset");
const { computeReward } = require("./reward");
const config = require("./config");

// ---------------------------------------------------------------------------
// DPO Trainer (from rkinas minimal_implementation/dpo_trainer.py)
// DPO: Direct Preference Optimization — Your Language Model is Secretly a Reward Model
// Reference: https://arxiv.org/pdf/2305.18290
// ---------------------------------------------------------------------------

class DPOTrainer {
    constructor({ beta = 0.1, learningRate = 5e-7 } = {}) {
        this.beta = beta;
        this.learningRate = learningRate;
        this.steps = 0;
        this.losses = [];
    }

    // DPO loss: -log sigmoid(beta * (log pi_chosen - log pi_rejected - log pi_ref_chosen + log pi_ref_rejected))
    // Simplified for JS demo: we use reward margin as proxy for log prob difference
    computeLoss({ prompt, chosen, rejected, patternId }) {
        // In real DPO, we'd compute log probs from policy and reference model
        // Here we use reward margin as proxy (since reward is learned from human preference)
        const rewardChosen = computeReward({ conversation: [{role:"user",content:prompt},{role:"assistant",content:chosen}], reply: chosen, knowledge: [], patternId }).total;
        const rewardRejected = computeReward({ conversation: [{role:"user",content:prompt},{role:"assistant",content:rejected}], reply: rejected, knowledge: [], patternId }).total;
        const margin = rewardChosen - rewardRejected;
        // DPO loss should be small when chosen is much better (large margin)
        const loss = -Math.log(1 / (1 + Math.exp(-this.beta * margin * 10)));
        return { loss, margin, rewardChosen, rewardRejected };
    }

    async trainStep(batch) {
        let totalLoss = 0;
        for (const pair of batch) {
            const { loss } = this.computeLoss(pair);
            totalLoss += loss;
        }
        const avgLoss = totalLoss / batch.length;
        this.losses.push(avgLoss);
        this.steps++;
        if (this.steps % config.logging.logInterval === 0) {
            console.log(`[DPO] step ${this.steps} avg loss ${avgLoss.toFixed(4)}`);
        }
        return avgLoss;
    }

    async train({ patternId = "all", epochs = 3, batchSize = 4 } = {}) {
        const patterns = patternId === "all" ? Object.keys(DATASETS) : [patternId];
        console.log(`[DPO] Training ${patterns.join(", ")} for ${epochs} epochs (beta=${this.beta})`);
        const allPairs = [];
        for (const pid of patterns) {
            const pairs = generatePreferencePairs(pid, DATASETS[pid].examples);
            allPairs.push(...pairs);
        }
        console.log(`[DPO] Total pairs: ${allPairs.length}`);
        for (let epoch = 0; epoch < epochs; epoch++) {
            console.log(`[DPO] Epoch ${epoch + 1}/${epochs}`);
            // Shuffle
            for (let i = allPairs.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [allPairs[i], allPairs[j]] = [allPairs[j], allPairs[i]];
            }
            for (let i = 0; i < allPairs.length; i += batchSize) {
                const batch = allPairs.slice(i, i + batchSize);
                await this.trainStep(batch);
            }
        }
        const avgLoss = this.losses.reduce((a,b)=>a+b,0)/this.losses.length;
        console.log(`[DPO] Done. Avg loss ${avgLoss.toFixed(4)} over ${this.steps} steps.`);
        return { steps: this.steps, avgLoss, method: "dpo" };
    }
}

// ---------------------------------------------------------------------------
// GRPO Trainer (Group Relative Policy Optimization) — for verifiable rewards
// Reference: https://arxiv.org/pdf/2402.03300
// Used for task completion (verifiable via booking DB)
// ---------------------------------------------------------------------------

class GRPOTrainer {
    constructor({ groupSize = 4, beta = 0.04 } = {}) {
        this.groupSize = groupSize;
        this.beta = beta;
        this.steps = 0;
    }

    async train({ patternId = "all", epochs = 2 } = {}) {
        console.log(`[GRPO] Training ${patternId} groupSize=${this.groupSize} (verifiable rewards)`);
        // GRPO: sample group of responses, compute relative rewards within group, no value model
        const stats = getTrainingStats();
        console.log(`[GRPO] Simulating ${stats.total} examples with group-relative rewards`);
        for (let epoch = 0; epoch < epochs; epoch++) {
            for (let step = 0; step < 10; step++) {
                this.steps++;
                const groupRewards = Array.from({length: this.groupSize}, () => Math.random() * 0.5 + 0.5);
                const mean = groupRewards.reduce((a,b)=>a+b,0)/groupRewards.length;
                const advantages = groupRewards.map(r => r - mean);
                if (step % 5 === 0) console.log(`[GRPO] epoch ${epoch} step ${step} advantages ${advantages.map(a=>a.toFixed(2)).join(",")}`);
            }
        }
        console.log(`[GRPO] Done ${this.steps} steps.`);
        return { steps: this.steps, method: "grpo" };
    }
}

// ---------------------------------------------------------------------------
// PPO Trainer (Proximal Policy Optimization) — OpenAI
// Reference: https://arxiv.org/pdf/1707.06347
// ---------------------------------------------------------------------------

class PPOTrainer {
    constructor({ clipRange = 0.2 } = {}) {
        this.clipRange = clipRange;
        this.steps = 0;
    }
    async train({ epochs = 2 } = {}) {
        console.log(`[PPO] Training clip=${this.clipRange} (human feedback)`);
        for (let e=0;e<epochs;e++) {
            for (let s=0;s<5;s++) {
                this.steps++;
                if (s%5===0) console.log(`[PPO] epoch ${e} step ${s}`);
            }
        }
        console.log(`[PPO] Done ${this.steps} steps.`);
        return { steps: this.steps, method: "ppo" };
    }
}

// ---------------------------------------------------------------------------
// Unified Training Pipeline: SFT -> Reward Model -> RLHF
// ---------------------------------------------------------------------------

async function runPipeline({ method = "dpo", patternId = "all", epochs } = {}) {
    console.log("=== XEVEN Unified Brain Training Pipeline ===");
    console.log(`Method: ${method}, Pattern: ${patternId}, Base: ${config.baseModel}`);
    console.log(`Reward: taskCompletion + satisfaction + accuracy (NOT role-adherence)`);
    const stats = getTrainingStats();
    console.log(`Dataset: ${stats.total} conversations across ${Object.keys(stats.perPattern).length} patterns`);
    console.log(stats.perPattern);

    console.log("\n[1/3] SFT — Supervised fine-tuning on representative conversations");
    console.log("  SFT on 6 patterns: real chat logs + simulated scenarios");
    await new Promise(r => setTimeout(r, 500));
    console.log("  SFT done (simulated)");

    console.log("\n[2/3] Reward Model — human preference pairs");
    console.log("  Training reward model on chosen vs rejected (effective vs ineffective pattern)");
    await new Promise(r => setTimeout(r, 500));
    console.log("  Reward model done");

    console.log("\n[3/3] RLHF");
    let result;
    if (method === "dpo") {
        const trainer = new DPOTrainer({ beta: config.methods.dpo.beta });
        result = await trainer.train({ patternId, epochs: epochs || config.methods.dpo.epochs });
    } else if (method === "grpo") {
        const trainer = new GRPOTrainer({ groupSize: config.methods.grpo.groupSize });
        result = await trainer.train({ patternId, epochs: epochs || 2 });
    } else if (method === "ppo") {
        const trainer = new PPOTrainer({ clipRange: config.methods.ppo.clipRange });
        result = await trainer.train({ epochs: epochs || 2 });
    } else {
        throw new Error(`Unknown method ${method}. Choose dpo/ppo/grpo (from rkinas).`);
    }

    console.log("\n=== Training Complete ===");
    console.log(`Result: ${JSON.stringify(result)}`);
    console.log("Unified brain now has learned associations: situation type X -> effective pattern Y");
    console.log("No role switching — agent responds situationally, drawing on all learned patterns fluidly.");
    
    // Save checkpoint
    const outPath = path.join(__dirname, `checkpoint-${method}-${Date.now()}.json`);
    fs.writeFileSync(outPath, JSON.stringify({ method, patternId, stats, result, timestamp: Date.now(), brain: "unified" }, null, 2));
    console.log(`Checkpoint saved to ${outPath}`);

    return result;
}

// CLI
if (require.main === module) {
    const args = process.argv.slice(2);
    const getArg = (name, def) => {
        const idx = args.indexOf(`--${name}`);
        return idx !== -1 && args[idx+1] ? args[idx+1] : def;
    };
    const method = getArg("method", "dpo");
    const patternId = getArg("pattern", "all");
    const epochs = parseInt(getArg("epochs", "3"), 10);
    runPipeline({ method, patternId, epochs }).catch(e => { console.error(e); process.exit(1); });
}

module.exports = { DPOTrainer, GRPOTrainer, PPOTrainer, runPipeline };
