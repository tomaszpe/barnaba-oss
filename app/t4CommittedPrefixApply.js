import { resegmentSourceAtWord } from './sourceResegmentation.js';
import { planT4CommittedPrefix } from './t4CommittedPrefixPlanner.js';

/**
 * Pure T4.1 decision + APPLY boundary.  The live Gateway and the controlled
 * runtime probe both call this function so the probe cannot drift into a
 * planner-only approximation of production behavior.
 */
export const evaluateT4CommittedPrefixApply = ({
    text,
    sourceLineage,
    sourceMap,
    proofs,
    safeBoundaryWordIndexes,
    ledgerVersion,
} = {}) => {
    const plan = planT4CommittedPrefix({
        sourceMap,
        proofs,
        safeBoundaryWordIndexes,
        ledgerVersion,
    });
    const result = plan.eligible
        ? resegmentSourceAtWord(text, sourceLineage, plan.safeBoundaryWord)
        : {
            action: 'unchanged',
            reason: plan.reason,
            text,
            sourceLineage,
        };
    const actionConsistent = !plan.eligible || result.action === plan.action;
    return Object.freeze({ plan, result, actionConsistent });
};
