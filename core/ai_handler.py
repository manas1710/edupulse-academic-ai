import os
import json
import re

class AIHandler:
    DIFFICULTY_GUIDELINES = {
        "Easy": """
DIFFICULTY LEVEL: EASY (Foundational Recall & Definition)
- Cognitive Depth: Direct recall, core definitions, basic terminology, standard formulas, and foundational facts explicitly covered in the subject.
- Question Style: Clear, straightforward, unambiguous questions (e.g., "What is...", "Which of the following defines...", or identifying core keywords).
- Distractors: 3 clearly incorrect options that are easily distinguishable to someone with basic subject knowledge. No trick questions or multi-step logic.
""",
        "Moderate": """
DIFFICULTY LEVEL: MODERATE (Application, Analysis & Scenarios)
- Cognitive Depth: Practical application, diagnosing realistic scenarios, comparing techniques, and analyzing trade-offs.
- Question Style: Scenario-based questions (e.g., "In a situation where...", "Which approach is best suited for...", "What is the expected outcome if...").
- Focus: Practical problem-solving, selecting appropriate algorithms/methods, differentiating similar concepts, understanding performance metrics.
- Distractors: Realistic, plausible misconceptions that test true conceptual understanding rather than rote memory.
""",
        "Hard": """
DIFFICULTY LEVEL: HARD (Deep Technical, Algorithmic Mechanics, Edge Cases & Mathematical Nuance)
- Cognitive Depth: Advanced technical analysis, mathematical/algorithmic mechanics, edge cases, subtle failure modes, optimization trade-offs, and multi-step reasoning.
- Question Style: In-depth analytical evaluation, architectural design decisions, analyzing corner cases, interpreting quantitative behavior, or debugging subtle conceptual flaws.
- Distractors: Highly sophisticated, plausible distractors that represent common advanced misconceptions or errors in mathematical/computational logic.
"""
    }

    def __init__(self, api_key=None):
        if api_key is None:
            api_key = os.environ.get("GEMINI_API_KEY", "")
        self.api_key = api_key
        
    def set_api_key(self, key):
        self.api_key = key

    @staticmethod
    def _normalize_text(text):
        if not text:
            return ""
        return re.sub(r'[^a-z0-9]', '', str(text).lower())

    def _is_duplicate(self, candidate_text, existing_texts):
        norm_candidate = self._normalize_text(candidate_text)
        if not norm_candidate:
            return True
        for existing in existing_texts:
            norm_existing = self._normalize_text(existing)
            if not norm_existing:
                continue
            if norm_candidate == norm_existing:
                return True
            if len(norm_candidate) > 30 and (norm_candidate in norm_existing or norm_existing in norm_candidate):
                return True
        return False
        
    def _generate_chunk(self, client, syllabus_text, chapter, count, difficulty, existing_questions=None):
        guideline = self.DIFFICULTY_GUIDELINES.get(difficulty, self.DIFFICULTY_GUIDELINES["Moderate"])
        
        existing_context = ""
        if existing_questions:
            prev_samples = [f"- {q.get('question')}" for q in existing_questions if q.get('question')]
            if prev_samples:
                sample_slice = prev_samples[-25:]
                existing_context = (
                    "\nSTRICT DEDUPLICATION RULE:\n"
                    "The following questions have ALREADY been created. You MUST NOT duplicate, rephrase, or cover the exact same concept or scenario as any of these:\n"
                    + "\n".join(sample_slice) + "\n"
                )

        prompt = f"""
You are an expert academic professor and assessment designer.
Based on the following syllabus or context:
{syllabus_text}

Generate exactly {count} unique, high-quality multiple choice questions (MCQs) for the topic/chapter: '{chapter}'.

{guideline}

{existing_context}

CRITICAL RULES:
1. EVERY question MUST be completely distinct and explore a different concept, subtopic, or aspect of '{chapter}'.
2. Strictly enforce the difficulty level specified above. There must be a sharp and noticeable difference in depth and rigor corresponding to the chosen difficulty level.
3. Return the result ONLY as a valid JSON list of {count} objects, where each object has:
- "question": The complete question text (string)
- "options": A list of exactly 4 distinct options (strings)
- "answer": The correct option text, matching one of the options verbatim.
- "explanation": A concise 1-sentence academic explanation of why the correct option is right (string).
"""
        models_to_try = [
            'gemini-2.5-flash',
            'gemini-2.0-flash',
            'gemini-flash-latest'
        ]
        last_error = None
        
        from google.genai import types
        for model_name in models_to_try:
            try:
                print(f"[AIHandler] Generating {count} questions ({difficulty}) with model: {model_name}...")
                response = client.models.generate_content(
                    model=model_name,
                    contents=prompt,
                    config=types.GenerateContentConfig(
                        response_mime_type="application/json",
                        max_output_tokens=8192,
                    ),
                )
                if response and response.text:
                    parsed = json.loads(response.text)
                    if isinstance(parsed, list) and len(parsed) > 0:
                        return parsed
            except Exception as e:
                print(f"[AIHandler] Model {model_name} failed: {e}")
                last_error = e
                continue
                
        raise Exception(f"Failed to generate questions: {str(last_error)}")

    def generate_offline_mcqs(self, syllabus_text, chapter, num_questions, difficulty="Moderate"):
        """
        Intelligent Offline Syllabus MCQ Generator used when internet is unavailable,
        API quota is exhausted, or Offline Mode is explicitly selected.
        """
        total_needed = max(1, int(num_questions or 5))
        topic_clean = (chapter or "Core Course Concepts").strip()
        diff_clean = (difficulty or "Moderate").strip().capitalize()

        # Extract meaningful concepts/phrases from syllabus_text and chapter
        raw_lines = [ln.strip() for ln in re.split(r'[\n\r•;]+', str(syllabus_text or "")) if ln.strip()]
        concepts = []
        stop_prefixes = ("course:", "syllabus modules:", "unit ", "chapter ", "module ")
        for ln in raw_lines:
            cleaned = re.sub(r'^(Unit\s*\d+\s*[:\-]|Chapter\s*\d+\s*[:\-]|\d+[\.\)]\s*)', '', ln, flags=re.IGNORECASE).strip()
            parts = [p.strip() for p in re.split(r'[,&/()\-–]+', cleaned) if 3 <= len(p.strip()) <= 65]
            for p in parts:
                if p.lower() not in [c.lower() for c in concepts] and not p.lower().startswith(stop_prefixes):
                    concepts.append(p)

        topic_stripped = re.sub(r'^(Unit\s*\d+\s*[:\-]|Chapter\s*\d+\s*[:\-])\s*', '', topic_clean, flags=re.IGNORECASE).strip()
        if topic_stripped and topic_stripped.lower() not in [c.lower() for c in concepts]:
            concepts.insert(0, topic_stripped)

        fallback_concepts = [
            f"{topic_stripped or 'Data Science'} Architecture",
            "Feature Engineering & Preprocessing",
            "Algorithmic Complexity & Optimization",
            "Cross-Validation & Generalization",
            "Statistical Inference & Hypothesis Testing",
            "Data Normalization & Outliers",
            "Model Evaluation Metrics (Precision, Recall, F1)",
            "Bias-Variance Trade-off",
            "Distributed Data Processing Pipelines",
            "Ethical AI & Reproducibility"
        ]
        for fc in fallback_concepts:
            if fc.lower() not in [c.lower() for c in concepts]:
                concepts.append(fc)

        templates_by_diff = {
            "Easy": [
                (
                    "In the study of {topic}, what is the primary purpose of applying {concept}?",
                    "To establish a reliable foundational representation and improve accuracy in {concept}",
                    "To intentionally increase random noise and discard structural metadata",
                    "To bypass all validation checks during initial data collection",
                    "To restrict the system exclusively to unindexed manual records",
                    "{concept} is fundamentally used in {topic} to ensure structured, reliable processing and accurate foundational analysis."
                ),
                (
                    "Which of the following best defines the core principle of {concept} within {topic}?",
                    "A systematic methodology for structuring, analyzing, and validating {concept} workflows",
                    "An ad-hoc technique that eliminates the need for input verification",
                    "A hardware-only constraint unrelated to computational logic",
                    "A deprecated protocol that prevents modular scalability",
                    "In {topic}, {concept} provides a systematic and verifiable methodology for handling domain workflows."
                ),
                (
                    "When introducing {concept} in {topic}, which characteristic is considered most essential?",
                    "Consistency, interpretability, and alignment with domain objectives",
                    "Maximizing memory overhead regardless of dataset size",
                    "Ignoring boundary conditions during initial setup",
                    "Relying solely on uncalibrated heuristic guesses",
                    "Consistency and interpretability are foundational requirements when working with {concept}."
                ),
            ],
            "Moderate": [
                (
                    "While implementing a solution for {topic}, a practitioner observes degraded performance during {concept}. Which corrective strategy is most effective?",
                    "Calibrate parameters systematically and validate {concept} using representative benchmark splits",
                    "Remove all validation metrics and deploy the uncalibrated model directly",
                    "Increase redundant features without checking for multicollinearity",
                    "Replace structured pipelines with static hard-coded thresholds",
                    "Systematic parameter calibration and validation splits directly address performance bottlenecks in {concept}."
                ),
                (
                    "In a practical scenario involving {topic}, how does {concept} improve overall system robustness?",
                    "By mitigating variance and ensuring consistent behavior across unseen inputs",
                    "By forcing the pipeline to memorize training anomalies verbatim",
                    "By disabling error logging during high-throughput execution",
                    "By coupling all modules into a single non-modular routine",
                    "{concept} strengthens system robustness by reducing sensitivity to noise and improving generalization."
                ),
                (
                    "When comparing approaches for {concept} in {topic}, what is the key trade-off an engineer must evaluate?",
                    "Balancing computational efficiency against predictive accuracy and interpretability",
                    "Choosing between syntax highlighting themes in the development environment",
                    "Maximizing disk fragmentation while minimizing network latency",
                    "Eliminating all test cases to shorten deployment time",
                    "Practical engineering in {topic} requires balancing computational cost against accuracy and interpretability for {concept}."
                ),
            ],
            "Hard": [
                (
                    "Under high-dimensional or edge-case distributions in {topic}, what is the primary failure mode if {concept} is not properly regularized?",
                    "Severe overfitting to boundary artifacts and unstable generalization variance",
                    "Automatic convergence to the global optimum in O(1) constant time",
                    "Complete elimination of epistemic and aleatoric uncertainty",
                    "Deterministic compression of non-linear manifolds without information loss",
                    "Without proper regularization or constraints in {concept}, high-dimensional spaces cause severe variance and boundary instability."
                ),
                (
                    "When optimizing the algorithmic pipeline for {concept} within {topic}, which condition guarantees asymptotic stability and reproducibility?",
                    "Enforcing bounded sensitivity, deterministic seeding, and rigorous cross-validation invariants",
                    "Allowing unbounded gradient updates across non-stationary partitions",
                    "Evaluating objective functions solely on in-sample training residuals",
                    "Sampling exclusively from the majority class while discarding tail distributions",
                    "Bounded sensitivity and rigorous validation invariants are required to guarantee stability in advanced {concept} pipelines."
                ),
                (
                    "In an advanced architectural analysis of {topic}, why can naive scaling of {concept} lead to suboptimal convergence?",
                    "Because unscaled interactions amplify conditioning errors and distort the underlying metric space",
                    "Because linear memory allocation strictly prohibits parallel execution threads",
                    "Because compiler optimizations automatically strip all floating-point operations",
                    "Because entropy strictly decreases whenever additional noisy dimensions are appended",
                    "Naive scaling in {concept} distorts the metric space and worsens numerical conditioning during optimization."
                ),
            ]
        }

        chosen_templates = templates_by_diff.get(diff_clean, templates_by_diff["Moderate"])
        questions = []

        for idx in range(total_needed):
            concept = concepts[idx % len(concepts)]
            tpl = chosen_templates[idx % len(chosen_templates)]
            if idx >= len(chosen_templates):
                q_stem = f"[Case #{idx + 1}] " + tpl[0].format(topic=topic_clean, concept=concept)
            else:
                q_stem = tpl[0].format(topic=topic_clean, concept=concept)

            correct_opt = tpl[1].format(topic=topic_clean, concept=concept)
            distractors = [
                tpl[2].format(topic=topic_clean, concept=concept),
                tpl[3].format(topic=topic_clean, concept=concept),
                tpl[4].format(topic=topic_clean, concept=concept),
            ]
            explanation = tpl[5].format(topic=topic_clean, concept=concept)

            # Rotate correct option position deterministically across A, B, C, D
            pos = idx % 4
            opts = list(distractors)
            opts.insert(pos, correct_opt)

            questions.append({
                "question": q_stem,
                "options": opts,
                "answer": correct_opt,
                "explanation": explanation
            })

        return questions

    def generate_mcqs(self, syllabus_text, chapter, num_questions, difficulty, force_offline=False):
        self.last_generation_mode = "ai"
        total_needed = int(num_questions) if num_questions else 5
        if total_needed <= 0:
            total_needed = 5

        diff_clean = difficulty.strip().capitalize() if difficulty else "Moderate"
        if diff_clean not in self.DIFFICULTY_GUIDELINES:
            diff_clean = "Moderate"

        if force_offline:
            self.last_generation_mode = "offline"
            return self.generate_offline_mcqs(syllabus_text, chapter, total_needed, diff_clean)

        key = self.api_key or os.environ.get("GEMINI_API_KEY", "")
        if not key or key == "PASTE_YOUR_GEMINI_API_KEY_HERE":
            self.last_generation_mode = "offline"
            return self.generate_offline_mcqs(syllabus_text, chapter, total_needed, diff_clean)

        try:
            from google import genai
            client = genai.Client(api_key=key)
            all_questions = []
            existing_question_texts = set()
            chunk_size = 15 if total_needed > 20 else total_needed
            max_attempts = 6
            attempt = 0

            while len(all_questions) < total_needed and attempt < max_attempts:
                attempt += 1
                remaining = total_needed - len(all_questions)
                current_batch_size = min(chunk_size, remaining)

                raw_batch = self._generate_chunk(
                    client,
                    syllabus_text,
                    chapter,
                    current_batch_size,
                    diff_clean,
                    existing_questions=all_questions
                )

                if not raw_batch:
                    break

                for q in raw_batch:
                    q_text = q.get('question', '').strip()
                    if not q_text:
                        continue
                    if not self._is_duplicate(q_text, existing_question_texts):
                        if not q.get("explanation"):
                            q["explanation"] = f"Correct Answer: {q.get('answer', '')} aligns with the core principles of {chapter}."
                        all_questions.append(q)
                        existing_question_texts.add(q_text)
                        if len(all_questions) >= total_needed:
                            break

            if len(all_questions) > 0:
                return all_questions[:total_needed]
        except Exception as e:
            print(f"[AIHandler] Online generation unavailable ({e}), falling back to Offline Smart Generator...")

        self.last_generation_mode = "offline"
        return self.generate_offline_mcqs(syllabus_text, chapter, total_needed, diff_clean)

