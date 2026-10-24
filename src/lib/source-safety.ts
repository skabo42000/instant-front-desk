import "server-only";

// Attack phrases, not single everyday words: salon sites say "aftercare instructions", "you should call"
// and "analytics tool". This is not a general injection detector; the model prompt and the answer
// checks are the other layers.
const attack = /\b(?:ignore|disregard|forget|override)\b(?:\s+(?:all|any|the|your|my|these|those|previous|prior|above|earlier))*\s+(?:rules?|instructions?|prompts?|polic(?:y|ies)|guidelines?)\b|system\s*prompt|developer\s*message|api\s*key|\breveal\s+(?:your|the)\b|\bpretend\s+(?:to\s+be|you)\b|\byou\s+are\s+now\b|\binstead\s+(?:say|answer|respond)\b|^\s*system\s*:/im;

export const hasSourceInstructions = (text: string): boolean => attack.test(text);
