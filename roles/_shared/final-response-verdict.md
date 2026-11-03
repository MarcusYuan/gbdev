Include review with verdict approve, revise, or reject and a findings array. The final worker-result JSON MUST include review.verdict and review.findings. Use approve only when no blocking issues remain; never approve with any critical/major finding. If unable to reach a conclusion, use revise with a finding explaining why; do not silently exit.

Findings must have unique ids matching ^F[0-9]{1,3}$, severity critical/major/minor/nit, file and suggestion as string or null, line as a positive integer or null, and a nonempty message. All finding fields are required.
