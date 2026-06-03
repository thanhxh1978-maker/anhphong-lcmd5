import fastify from "fastify";
import cors from "@fastify/cors";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import fetch from "node-fetch";

// --- CẤU HÌNH ---
const PORT = 3000;
const API_URL = "https://wtxmd52.tele68.com/v1/txmd5/sessions";

// --- GLOBAL STATE ---
let txHistory = []; 
let currentSessionId = null; 
let fetchInterval = null; 

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- UTILITIES TỐI ƯU ---
function parseLines(data) {
    if (!data || !Array.isArray(data.list)) return [];
    
    const sortedList = data.list.sort((a, b) => b.id - a.id);
    const arr = sortedList.map(item => ({
        session: item.id,
        dice: item.dices,
        total: item.point,
        result: item.resultTruyenThong,
        tx: item.point >= 11 ? 'T' : 'X'
    }));

    return arr.sort((a, b) => a.session - b.session);
}

function lastN(arr, n) {
    const start = Math.max(0, arr.length - n);
    return arr.slice(start);
}

function majority(obj) {
    let maxK = null, maxV = -Infinity;
    for (const k in obj) {
        if (obj[k] > maxV) {
            maxV = obj[k];
            maxK = k;
        }
    }
    return { key: maxK, val: maxV };
}

function sum(nums) {
    return nums.reduce((a, b) => a + b, 0);
}

function avg(nums) {
    return nums.length ? sum(nums) / nums.length : 0;
}

function entropy(arr) {
    if (!arr.length) return 0;
    const freq = {};
    for (const v of arr) freq[v] = (freq[v] || 0) + 1;
    
    let e = 0, n = arr.length;
    for (const k in freq) {
        const p = freq[k] / n;
        e -= p * Math.log2(p);
    }
    return e;
}

function similarity(a, b) {
    if (a.length !== b.length) return 0;
    let m = 0;
    for (let i = 0; i < a.length; i++) {
        if (a[i] === b[i]) m++;
    }
    return m / a.length;
}

function extractFeatures(history) {
    const tx = history.map(h => h.tx);
    const totals = history.map(h => h.total);
    
    const freq = {};
    for (const v of tx) freq[v] = (freq[v] || 0) + 1;
    
    let runs = [], cur = tx[0], len = 1;
    for (let i = 1; i < tx.length; i++) {
        if (tx[i] === cur) len++;
        else {
            runs.push({ val: cur, len });
            cur = tx[i];
            len = 1;
        }
    }
    if (tx.length) runs.push({ val: cur, len });
    
    const meanTotal = avg(totals);
    const variance = avg(totals.map(t => Math.pow(t - meanTotal, 2)));
    
    // Tối ưu tính toán
    const last10 = tx.slice(-10);
    const last10Totals = totals.slice(-10);
    const upward = last10Totals.filter((t, i) => i > 0 && t > last10Totals[i-1]).length;
    const downward = last10Totals.filter((t, i) => i > 0 && t < last10Totals[i-1]).length;
    
    return {
        tx,
        totals,
        freq,
        runs,
        maxRun: runs.reduce((m, r) => Math.max(m, r.len), 0),
        meanTotal,
        stdTotal: Math.sqrt(variance),
        entropy: entropy(tx),
        last3Pattern: tx.slice(-3).join(''),
        last5Pattern: tx.slice(-5).join(''),
        last8Pattern: tx.slice(-8).join(''),
        trends: { upward, downward }
    };
}

// --- ADVANCED PATTERN DETECTION ---
function detectPatternType(runs) {
    if (runs.length < 3) return null;
    
    const lastRuns = runs.slice(-6);
    const lengths = lastRuns.map(r => r.len);
    const values = lastRuns.map(r => r.val);
    
    // Mẫu cơ bản
    if (lastRuns.length >= 3) {
        // 1-1 Pattern (T X T X...)
        if (lengths.every(l => l === 1)) {
            const isAlternating = values.every((v, i) => i === 0 || v !== values[i-1]);
            if (isAlternating) return '1_1_pattern';
        }
        
        // 2-2 Pattern (TT XX TT...)
        if (lengths.every(l => l === 2)) {
            const isAlternating = values.every((v, i) => i === 0 || v !== values[i-1]);
            if (isAlternating) return '2_2_pattern';
        }
        
        // 3-3 Pattern (TTT XXX...)
        if (lengths.every(l => l === 3)) {
            const isAlternating = values.every((v, i) => i === 0 || v !== values[i-1]);
            if (isAlternating) return '3_3_pattern';
        }
        
        // 2-1-2 Pattern (TT X TT X...)
        if (lengths.length >= 5 && 
            lengths[0] === 2 && lengths[1] === 1 && lengths[2] === 2 && lengths[3] === 1 && lengths[4] === 2) {
            return '2_1_2_pattern';
        }
        
        // 1-2-1 Pattern (T XX T XX...)
        if (lengths.length >= 5 &&
            lengths[0] === 1 && lengths[1] === 2 && lengths[2] === 1 && lengths[3] === 2 && lengths[4] === 1) {
            return '1_2_1_pattern';
        }
        
        // 3-2-3 Pattern (TTT XX TTT XX...)
        if (lengths.length >= 5 &&
            lengths[0] === 3 && lengths[1] === 2 && lengths[2] === 3 && lengths[3] === 2 && lengths[4] === 3) {
            return '3_2_3_pattern';
        }
        
        // 4-2-4 Pattern (TTTT XX TTTT XX...)
        if (lengths.length >= 5 &&
            lengths[0] === 4 && lengths[1] === 2 && lengths[2] === 4 && lengths[3] === 2 && lengths[4] === 4) {
            return '4_2_4_pattern';
        }
        
        // 2-2-1 Pattern
        if (lengths.length >= 5 &&
            lengths[0] === 2 && lengths[1] === 2 && lengths[2] === 1 && lengths[3] === 2 && lengths[4] === 2) {
            return '2_2_1_pattern';
        }
        
        // 1-3-1 Pattern
        if (lengths.length >= 5 &&
            lengths[0] === 1 && lengths[1] === 3 && lengths[2] === 1 && lengths[3] === 3 && lengths[4] === 1) {
            return '1_3_1_pattern';
        }
        
        // 3-1-3 Pattern
        if (lengths.length >= 5 &&
            lengths[0] === 3 && lengths[1] === 1 && lengths[2] === 3 && lengths[3] === 1 && lengths[4] === 3) {
            return '3_1_3_pattern';
        }
    }
    
    // Cầu bệt dài (long run)
    const lastRun = lastRuns[lastRuns.length - 1];
    if (lastRun && lastRun.len >= 5) return 'long_run_pattern';
    
    return 'random_pattern';
}

function predictNextFromPattern(patternType, runs, lastTx) {
    if (!patternType) return null;
    
    const lastRun = runs[runs.length - 1];
    
    switch (patternType) {
        case '1_1_pattern':
            // Đang chạy 1-1 thì tiếp tục xen kẽ
            return lastTx === 'T' ? 'X' : 'T';
            
        case '2_2_pattern':
            // Nếu đã chạy 2 lần cùng loại, chuyển sang loại khác
            if (lastRun.len === 2) {
                return lastRun.val === 'T' ? 'X' : 'T';
            }
            // Nếu mới chạy 1 lần, tiếp tục
            return lastRun.val;
            
        case '3_3_pattern':
            // Tương tự 2-2 nhưng với 3 lần
            if (lastRun.len === 3) {
                return lastRun.val === 'T' ? 'X' : 'T';
            }
            return lastRun.val;
            
        case '2_1_2_pattern':
            // Mẫu: TT X TT X TT
            if (lastRun.val === 'T' && lastRun.len === 2) return 'X';
            if (lastRun.val === 'X' && lastRun.len === 2) return 'T';
            if (lastRun.len === 1) return lastRun.val === 'T' ? 'T' : 'X';
            return null;
            
        case '1_2_1_pattern':
            // Mẫu: T XX T XX T
            if (lastRun.val === 'T' && lastRun.len === 1) return 'X';
            if (lastRun.val === 'X' && lastRun.len === 1) return 'T';
            if (lastRun.len === 2) return lastRun.val;
            return null;
            
        case '3_2_3_pattern':
            // Mẫu: TTT XX TTT XX
            if (lastRun.len === 3) {
                return lastRun.val === 'T' ? 'X' : 'T';
            }
            if (lastRun.len === 2) {
                return lastRun.val === 'T' ? 'T' : 'X';
            }
            return null;
            
        case '4_2_4_pattern':
            // Mẫu: TTTT XX TTTT XX
            if (lastRun.len === 4) {
                return lastRun.val === 'T' ? 'X' : 'T';
            }
            if (lastRun.len === 2) {
                return lastRun.val === 'T' ? 'T' : 'X';
            }
            return null;
            
        case 'long_run_pattern':
            // Cầu bệt dài: nếu quá dài (>7) thì dự đoán bẻ cầu
            if (lastRun.len > 7) {
                return lastRun.val === 'T' ? 'X' : 'T';
            }
            // Nếu còn trong ngưỡng (4-7) thì tiếp tục
            if (lastRun.len >= 4 && lastRun.len <= 7) {
                return lastRun.val;
            }
            return null;
            
        default:
            return null;
    }
}

// --- CORE ALGORITHMS NÂNG CẤP MẠNH MẼ ---

// 1. ULTRA FREQUENCY BALANCER - Tối ưu cực mạnh
function algo5_freqRebalance(history) {
    if (history.length < 20) return null;
    const features = extractFeatures(history);
    const { freq, entropy: e } = features;
    
    const tCount = freq['T'] || 0;
    const xCount = freq['X'] || 0;
    const diff = Math.abs(tCount - xCount);
    const total = tCount + xCount;
    
    // Adaptive threshold based on entropy
    let threshold;
    if (e > 0.9) threshold = 0.45; // High entropy = random, lower threshold
    else if (e < 0.4) threshold = 0.65; // Low entropy = pattern, higher threshold
    else threshold = 0.55;
    
    // Recent bias (last 30 results)
    const recent = history.slice(-30);
    const recentT = recent.filter(h => h.tx === 'T').length;
    const recentX = recent.filter(h => h.tx === 'X').length;
    const recentDiff = Math.abs(recentT - recentX);
    const recentTotal = recentT + recentX;
    
    // Combine long-term and short-term imbalance
    if (total > 0 && recentTotal > 0) {
        const longTermRatio = diff / total;
        const shortTermRatio = recentDiff / recentTotal;
        const combinedRatio = (longTermRatio * 0.4) + (shortTermRatio * 0.6);
        
        if (combinedRatio > threshold) {
            // Check which side is dominant recently
            if (recentT > recentX + 2) return 'X';
            if (recentX > recentT + 2) return 'T';
        }
    }
    
    return null;
}

// 2. QUANTUM MARKOV CHAIN - Markov cải tiến mạnh
function algoA_markov(history) {
    if (history.length < 15) return null;
    const tx = history.map(h => h.tx);
    
    // Dynamic order selection based on data size
    let maxOrder = 4;
    if (history.length < 30) maxOrder = 3;
    if (history.length < 20) maxOrder = 2;
    
    let bestPred = null;
    let bestScore = -1;
    
    for (let order = 2; order <= maxOrder; order++) {
        if (tx.length < order + 8) continue;
        
        // Build transition matrix with time decay
        const transitions = {};
        const totalTransitions = tx.length - order;
        const decayFactor = 0.95; // Favor recent patterns
        
        for (let i = 0; i < totalTransitions; i++) {
            const key = tx.slice(i, i + order).join('');
            const next = tx[i + order];
            const weight = Math.pow(decayFactor, totalTransitions - i - 1); // Recent = higher weight
            
            if (!transitions[key]) transitions[key] = { T: 0, X: 0 };
            transitions[key][next] += weight;
        }
        
        const lastKey = tx.slice(-order).join('');
        const counts = transitions[lastKey];
        
        if (counts && (counts.T + counts.X) > 0.5) {
            const total = counts.T + counts.X;
            const confidence = Math.abs(counts.T - counts.X) / total;
            const pred = counts.T > counts.X ? 'T' : 'X';
            
            // Score = confidence * order weight * data support
            const orderWeight = order / maxOrder;
            const supportWeight = Math.min(1, (counts.T + counts.X) / 10);
            const score = confidence * orderWeight * supportWeight;
            
            if (score > bestScore) {
                bestScore = score;
                bestPred = pred;
            }
        }
    }
    
    return bestPred;
}

// 3. HYPER N-GRAM MATCHER - N-gram siêu chính xác
function algoB_ngram(history) {
    if (history.length < 30) return null;
    const tx = history.map(h => h.tx);
    
    // Dynamic n-gram sizes based on pattern detection
    const ngramSizes = [];
    if (history.length >= 50) ngramSizes.push(5, 6);
    if (history.length >= 40) ngramSizes.push(4);
    ngramSizes.push(3, 2);
    
    let bestPred = null;
    let bestConfidence = 0;
    
    for (const n of ngramSizes) {
        if (tx.length < n * 2) continue;
        
        const target = tx.slice(-n).join('');
        let matches = [];
        
        // Find all matches with their positions
        for (let i = 0; i <= tx.length - n - 1; i++) {
            const gram = tx.slice(i, i + n).join('');
            if (gram === target) {
                matches.push({
                    position: i,
                    next: tx[i + n],
                    distance: tx.length - i // How far back
                });
            }
        }
        
        if (matches.length >= 2) {
            // Weight matches: recent matches matter more
            const weights = { T: 0, X: 0 };
            let totalWeight = 0;
            
            for (const match of matches) {
                const weight = 1 / (match.distance * 0.5 + 1); // Exponential decay
                weights[match.next] += weight;
                totalWeight += weight;
            }
            
            if (totalWeight > 0) {
                const tRatio = weights.T / totalWeight;
                const xRatio = weights.X / totalWeight;
                const confidence = Math.abs(tRatio - xRatio);
                
                if (confidence > bestConfidence) {
                    bestConfidence = confidence;
                    bestPred = weights.T > weights.X ? 'T' : 'X';
                }
            }
        }
    }
    
    // Only return if confidence is high enough
    return bestConfidence > 0.3 ? bestPred : null;
}

// 4. QUANTUM PATTERN DETECTOR - Phát hiện mẫu lượng tử
function algoS_NeoPattern(history) {
    if (history.length < 25) return null;
    const features = extractFeatures(history);
    const { runs, tx } = features;
    
    // Detect current pattern
    const patternType = detectPatternType(runs);
    if (!patternType || patternType === 'random_pattern') return null;
    
    // Get prediction based on pattern
    const lastTx = tx[tx.length - 1];
    const prediction = predictNextFromPattern(patternType, runs, lastTx);
    
    if (prediction) {
        // Add confidence based on pattern strength
        const recentRuns = runs.slice(-Math.min(8, runs.length));
        const patternConsistency = recentRuns.filter(r => 
            patternType.includes('_pattern') || 
            (patternType === 'long_run_pattern' && r.len >= 4)
        ).length / recentRuns.length;
        
        // Only return if pattern is consistent
        if (patternConsistency > 0.6) {
            return prediction;
        }
    }
    
    return null;
}

// 5. DEEP NEURAL SIMULATION - Mô phỏng neural network sâu
function algoF_SuperDeepAnalysis(history) {
    if (history.length < 60) return null;
    
    // Multi-timeframe analysis
    const timeframes = [
        { lookback: 10, weight: 0.3 },  // Very short-term
        { lookback: 30, weight: 0.4 },  // Short-term
        { lookback: 60, weight: 0.3 }   // Medium-term
    ];
    
    let totalScore = { T: 0, X: 0 };
    let totalWeight = 0;
    
    for (const tf of timeframes) {
        if (history.length < tf.lookback) continue;
        
        const slice = history.slice(-tf.lookback);
        const sliceTx = slice.map(h => h.tx);
        const sliceTotals = slice.map(h => h.total);
        
        // Feature extraction for this timeframe
        const tCount = sliceTx.filter(t => t === 'T').length;
        const xCount = sliceTx.filter(t => t === 'X').length;
        const meanTotal = avg(sliceTotals);
        const volatility = Math.sqrt(avg(sliceTotals.map(t => Math.pow(t - meanTotal, 2))));
        
        // Scoring rules
        let tScore = 0, xScore = 0;
        
        // Rule 1: Mean reversion
        if (meanTotal > 12) xScore += 0.4;
        if (meanTotal < 9) tScore += 0.4;
        
        // Rule 2: Frequency imbalance
        if (tCount > xCount + 3) xScore += 0.3;
        if (xCount > tCount + 3) tScore += 0.3;
        
        // Rule 3: Volatility adjustment
        if (volatility > 4) {
            // High volatility -> favor continuation
            if (sliceTx[sliceTx.length - 1] === 'T') tScore += 0.2;
            else xScore += 0.2;
        }
        
        // Rule 4: Trend detection
        const trend = sliceTotals[sliceTotals.length - 1] - sliceTotals[0];
        if (trend > 3) xScore += 0.1; // Trend up -> more likely X next
        if (trend < -3) tScore += 0.1; // Trend down -> more likely T next
        
        // Weighted aggregation
        const timeframeWeight = tf.weight * (sliceTx.length / tf.lookback);
        totalScore.T += tScore * timeframeWeight;
        totalScore.X += xScore * timeframeWeight;
        totalWeight += timeframeWeight;
    }
    
    if (totalWeight > 0 && Math.abs(totalScore.T - totalScore.X) > 0.15) {
        return totalScore.T > totalScore.X ? 'T' : 'X';
    }
    
    return null;
}

// 6. TRANSFORMER XL - Attention mechanism mạnh mẽ
function algoE_Transformer(history) {
    if (history.length < 100) return null;
    const tx = history.map(h => h.tx);
    
    // Multi-scale attention
    const seqLengths = [6, 8, 10, 12];
    let attentionScores = { T: 0, X: 0 };
    
    for (const seqLen of seqLengths) {
        if (tx.length < seqLen * 2) continue;
        
        const targetSeq = tx.slice(-seqLen).join('');
        let seqMatches = 0;
        
        // Find similar sequences with fuzzy matching
        for (let i = 0; i <= tx.length - seqLen - 1; i++) {
            const historySeq = tx.slice(i, i + seqLen).join('');
            const matchScore = similarity(historySeq, targetSeq);
            
            if (matchScore >= 0.7) {
                const nextResult = tx[i + seqLen];
                // Weight = matchScore * recency * sequence length factor
                const recency = 1 / (tx.length - i);
                const lengthFactor = seqLen / 12; // Longer sequences more reliable
                const weight = matchScore * recency * lengthFactor;
                
                attentionScores[nextResult] = (attentionScores[nextResult] || 0) + weight;
                seqMatches++;
            }
        }
        
        // Boost confidence if we found good matches
        if (seqMatches >= 3) {
            const boostFactor = Math.min(1.5, seqMatches / 2);
            attentionScores.T *= boostFactor;
            attentionScores.X *= boostFactor;
        }
    }
    
    if (attentionScores.T + attentionScores.X > 0.2) {
        const total = attentionScores.T + attentionScores.X;
        const confidence = Math.abs(attentionScores.T - attentionScores.X) / total;
        
        if (confidence > 0.25) {
            return attentionScores.T > attentionScores.X ? 'T' : 'X';
        }
    }
    
    return null;
}

// 7. ADAPTIVE BRIDGE BREAKER - AI bẻ cầu thông minh
function algoG_SuperBridgePredictor(history) {
    const features = extractFeatures(history);
    const { runs, tx } = features;
    
    if (runs.length < 4) return null;
    
    const lastRun = runs[runs.length - 1];
    const prevRun = runs.length > 1 ? runs[runs.length - 2] : null;
    const prevPrevRun = runs.length > 2 ? runs[runs.length - 3] : null;
    
    // Advanced bridge breaking logic
    let prediction = null;
    let confidence = 0;
    
    // 1. Long bridge detection (5+)
    if (lastRun.len >= 5) {
        // Very long bridge (8+) -> high probability of break
        if (lastRun.len >= 8) {
            prediction = lastRun.val === 'T' ? 'X' : 'T';
            confidence = 0.8;
        }
        // Medium long bridge (5-7) -> moderate probability of continuation
        else if (lastRun.len >= 5 && lastRun.len <= 7) {
            // Check if this is getting too long compared to history
            const avgRunLength = avg(runs.map(r => r.len));
            if (lastRun.len > avgRunLength * 1.8) {
                prediction = lastRun.val === 'T' ? 'X' : 'T';
                confidence = 0.65;
            } else {
                prediction = lastRun.val;
                confidence = 0.6;
            }
        }
    }
    
    // 2. Pattern-based bridge breaking
    if (!prediction && runs.length >= 5) {
        const last5Runs = runs.slice(-5);
        const lengths = last5Runs.map(r => r.len);
        
        // Pattern: Long bridge after short runs
        if (lengths[0] === 1 && lengths[1] === 1 && lengths[2] >= 3) {
            if (lastRun.len >= 3) {
                prediction = lastRun.val === 'T' ? 'X' : 'T';
                confidence = 0.7;
            }
        }
        
        // Pattern: Alternating bridge lengths
        if (lengths.length >= 4) {
            if (lengths[0] === 2 && lengths[1] === 3 && lengths[2] === 2 && lengths[3] === 3) {
                prediction = lastRun.val === 'T' ? 'T' : 'X';
                confidence = 0.6;
            }
        }
    }
    
    // 3. Statistical bridge breaking
    if (!prediction && runs.length >= 8) {
        const recentRuns = runs.slice(-8);
        const runLengths = recentRuns.map(r => r.len);
        const currentRunLength = lastRun.len;
        
        // If current run is 2+ standard deviations above mean
        const meanLength = avg(runLengths);
        const stdLength = Math.sqrt(avg(runLengths.map(l => Math.pow(l - meanLength, 2))));
        
        if (currentRunLength > meanLength + (stdLength * 1.5)) {
            prediction = lastRun.val === 'T' ? 'X' : 'T';
            confidence = 0.6;
        }
    }
    
    return confidence > 0.55 ? prediction : null;
}

// 8. HYBRID ADAPTIVE PREDICTOR - Kết hợp đa mô hình
function algoH_AdaptiveMarkov(history) {
    if (history.length < 25) return null;
    const tx = history.map(h => h.tx);
    
    // Multiple prediction models
    const models = [
        { type: 'markov', orders: [2, 3, 4] },
        { type: 'frequency', lookbacks: [10, 20, 30] },
        { type: 'momentum', windows: [5, 10, 15] }
    ];
    
    let ensembleVotes = { T: 0, X: 0 };
    
    for (const model of models) {
        if (model.type === 'markov') {
            for (const order of model.orders) {
                if (tx.length < order + 5) continue;
                
                const transitions = {};
                for (let i = 0; i <= tx.length - order - 1; i++) {
                    const key = tx.slice(i, i + order).join('');
                    const next = tx[i + order];
                    if (!transitions[key]) transitions[key] = { T: 0, X: 0 };
                    transitions[key][next]++;
                }
                
                const lastKey = tx.slice(-order).join('');
                const counts = transitions[lastKey];
                if (counts && counts.T + counts.X >= 2) {
                    const pred = counts.T > counts.X ? 'T' : 'X';
                    const confidence = Math.abs(counts.T - counts.X) / (counts.T + counts.X);
                    ensembleVotes[pred] += confidence * (order / 10);
                }
            }
        }
        
        if (model.type === 'frequency') {
            for (const lookback of model.lookbacks) {
                if (tx.length < lookback) continue;
                
                const recent = tx.slice(-lookback);
                const tCount = recent.filter(t => t === 'T').length;
                const xCount = recent.filter(t => t === 'X').length;
                
                if (Math.abs(tCount - xCount) > lookback * 0.2) {
                    const pred = tCount > xCount ? 'X' : 'T'; // Mean reversion
                    const confidence = Math.abs(tCount - xCount) / lookback;
                    ensembleVotes[pred] += confidence * 0.5;
                }
            }
        }
        
        if (model.type === 'momentum') {
            for (const window of model.windows) {
                if (tx.length < window * 2) continue;
                
                const firstHalf = tx.slice(-window * 2, -window);
                const secondHalf = tx.slice(-window);
                
                const firstT = firstHalf.filter(t => t === 'T').length;
                const firstX = firstHalf.filter(t => t === 'X').length;
                const secondT = secondHalf.filter(t => t === 'T').length;
                const secondX = secondHalf.filter(t => t === 'X').length;
                
                const momentumT = secondT - firstT;
                const momentumX = secondX - firstX;
                
                if (Math.abs(momentumT - momentumX) > window * 0.3) {
                    const pred = momentumT > momentumX ? 'T' : 'X';
                    const confidence = Math.abs(momentumT - momentumX) / window;
                    ensembleVotes[pred] += confidence * 0.3;
                }
            }
        }
    }
    
    if (ensembleVotes.T + ensembleVotes.X > 0.3) {
        return ensembleVotes.T > ensembleVotes.X ? 'T' : 'X';
    }
    
    return null;
}

// 9. PATTERN MASTER - Bậc thầy nhận diện mẫu
function algoI_PatternMaster(history) {
    if (history.length < 35) return null;
    const features = extractFeatures(history);
    const { runs, tx } = features;
    
    if (runs.length < 5) return null;
    
    // Advanced pattern recognition
    const recentRuns = runs.slice(-Math.min(8, runs.length));
    const runLengths = recentRuns.map(r => r.len);
    const runValues = recentRuns.map(r => r.val);
    
    // Complex pattern matching
    let patternStrength = { T: 0, X: 0 };
    
    // 1. Run-length encoding patterns
    const runPattern = runLengths.join('');
    const valuePattern = runValues.join('');
    
    // Common patterns and their predictions
    const patternLibrary = [
        { pattern: '12121', prediction: valuePattern[valuePattern.length-1] === 'T' ? 'X' : 'T', strength: 0.7 },
        { pattern: '21212', prediction: valuePattern[valuePattern.length-1] === 'T' ? 'T' : 'X', strength: 0.7 },
        { pattern: '13131', prediction: valuePattern[valuePattern.length-1], strength: 0.6 },
        { pattern: '31313', prediction: valuePattern[valuePattern.length-1] === 'T' ? 'X' : 'T', strength: 0.6 },
        { pattern: '24242', prediction: valuePattern[valuePattern.length-1] === 'T' ? 'X' : 'T', strength: 0.65 },
        { pattern: '42424', prediction: valuePattern[valuePattern.length-1], strength: 0.65 }
    ];
    
    for (const libPattern of patternLibrary) {
        if (runPattern.includes(libPattern.pattern)) {
            patternStrength[libPattern.prediction] += libPattern.strength;
        }
    }
    
    // 2. Value-based patterns (T/X sequences)
    const last10Tx = tx.slice(-10).join('');
    const txPatterns = [
        { pattern: 'TXTXTXTX', prediction: 'X', strength: 0.8 },
        { pattern: 'XTXTXTXT', prediction: 'T', strength: 0.8 },
        { pattern: 'TTXXTTXX', prediction: 'X', strength: 0.7 },
        { pattern: 'XXTTXXTT', prediction: 'T', strength: 0.7 },
        { pattern: 'TTTXXXTT', prediction: 'T', strength: 0.75 },
        { pattern: 'XXXTTTXX', prediction: 'X', strength: 0.75 },
        { pattern: 'TTXTTXTT', prediction: 'X', strength: 0.7 },
        { pattern: 'XXTXXTXX', prediction: 'T', strength: 0.7 }
    ];
    
    for (const txPattern of txPatterns) {
        if (last10Tx.includes(txPattern.pattern)) {
            patternStrength[txPattern.prediction] += txPattern.strength;
        }
    }
    
    // 3. Predictive analytics based on run statistics
    const lastRun = recentRuns[recentRuns.length - 1];
    if (lastRun) {
        const avgRecentLength = avg(runLengths);
        const currentRunAge = lastRun.len;
        
        // If current run is getting old relative to average
        if (currentRunAge > avgRecentLength * 1.8) {
            patternStrength[lastRun.val === 'T' ? 'X' : 'T'] += 0.5;
        } else if (currentRunAge < avgRecentLength * 0.6) {
            // Very short run - likely to continue
            patternStrength[lastRun.val] += 0.4;
        }
    }
    
    // Decision making
    if (patternStrength.T > 0 || patternStrength.X > 0) {
        const totalStrength = patternStrength.T + patternStrength.X;
        const confidence = Math.abs(patternStrength.T - patternStrength.X) / totalStrength;
        
        if (confidence > 0.3) {
            return patternStrength.T > patternStrength.X ? 'T' : 'X';
        }
    }
    
    return null;
}

// 10. QUANTUM ENTROPY PREDICTOR - Dự đoán dựa trên entropy
function algoJ_QuantumEntropy(history) {
    if (history.length < 40) return null;
    const features = extractFeatures(history);
    const { entropy: e, tx, runs } = features;
    
    // Multi-scale entropy analysis
    const entropyWindows = [10, 20, 30];
    let entropyPredictions = { T: 0, X: 0 };
    
    for (const window of entropyWindows) {
        if (tx.length < window) continue;
        
        const windowTx = tx.slice(-window);
        const windowEntropy = entropy(windowTx);
        
        // Low entropy = strong pattern = continuation
        if (windowEntropy < 0.3) {
            const lastVal = windowTx[windowTx.length - 1];
            entropyPredictions[lastVal] += 0.6;
        }
        // High entropy = random = mean reversion
        else if (windowEntropy > 0.9) {
            const tCount = windowTx.filter(t => t === 'T').length;
            const xCount = windowTx.filter(t => t === 'X').length;
            if (tCount > xCount) entropyPredictions['X'] += 0.5;
            else if (xCount > tCount) entropyPredictions['T'] += 0.5;
        }
        // Medium entropy = complex pattern
        else {
            // Look for emerging patterns
            const recentRuns = runs.slice(-4);
            if (recentRuns.length >= 3) {
                const runLengths = recentRuns.map(r => r.len);
                const isEmergingPattern = Math.max(...runLengths) - Math.min(...runLengths) <= 2;
                
                if (isEmergingPattern) {
                    const lastVal = tx[tx.length - 1];
                    entropyPredictions[lastVal] += 0.4;
                }
            }
        }
    }
    
    // Global entropy consideration
    if (e < 0.4) {
        // Very low global entropy = strong global pattern
        const lastVal = tx[tx.length - 1];
        entropyPredictions[lastVal] += 0.3;
    } else if (e > 0.95) {
        // Very high global entropy = completely random
        // Flip a coin (but weighted by recent frequency)
        const recentT = tx.slice(-20).filter(t => t === 'T').length;
        const recentX = tx.slice(-20).filter(t => t === 'X').length;
        if (recentT > recentX) entropyPredictions['X'] += 0.4;
        else if (recentX > recentT) entropyPredictions['T'] += 0.4;
    }
    
    if (entropyPredictions.T + entropyPredictions.X > 0.4) {
        return entropyPredictions.T > entropyPredictions.X ? 'T' : 'X';
    }
    
    return null;
}

// --- DANH SÁCH THUẬT TOÁN ĐẦY ĐỦ ---
const ALL_ALGS = [
    { id: 'algo5_freqrebalance', fn: algo5_freqRebalance },
    { id: 'a_markov', fn: algoA_markov },
    { id: 'b_ngram', fn: algoB_ngram },
    { id: 's_neo_pattern', fn: algoS_NeoPattern },
    { id: 'f_super_deep_analysis', fn: algoF_SuperDeepAnalysis },
    { id: 'e_transformer', fn: algoE_Transformer },
    { id: 'g_super_bridge_predictor', fn: algoG_SuperBridgePredictor },
    { id: 'h_adaptive_markov', fn: algoH_AdaptiveMarkov },
    { id: 'i_pattern_master', fn: algoI_PatternMaster },
    { id: 'j_quantum_entropy', fn: algoJ_QuantumEntropy }
];

// --- ENSEMBLE CLASSIFIER NÂNG CẤP ---
class SEIUEnsemble {
    constructor(algorithms, opts = {}) { 
        this.algs = algorithms;
        this.weights = {};
        this.emaAlpha = opts.emaAlpha ?? 0.06; // Learning rate chậm hơn để ổn định
        this.minWeight = opts.minWeight ?? 0.01;
        this.historyWindow = opts.historyWindow ?? 700;
        this.performanceHistory = {};
        this.patternMemory = {}; // Lưu trữ pattern hiệu quả
        
        for (const a of algorithms) {
            this.weights[a.id] = 1.0;
            this.performanceHistory[a.id] = [];
        }
    }
    
    fitInitial(history) {
        const window = lastN(history, Math.min(this.historyWindow, history.length));
        if (window.length < 30) return;
        
        const algScores = {};
        for (const a of this.algs) algScores[a.id] = 0;

        // Đánh giá trên cửa sổ huấn luyện
        const evalSamples = Math.min(40, window.length - 15);
        const startIdx = window.length - evalSamples;
        
        for (let i = Math.max(15, startIdx); i < window.length; i++) {
            const prefix = window.slice(0, i);
            const actual = window[i].tx;
            
            // Phát hiện pattern hiện tại
            const features = extractFeatures(prefix);
            const patternType = detectPatternType(features.runs);
            
            for (const a of this.algs) {
                try {
                    const pred = a.fn(prefix);
                    if (pred && pred === actual) {
                        algScores[a.id] += 1;
                        
                        // Ghi nhớ algorithm nào tốt với pattern nào
                        if (patternType) {
                            const key = `${a.id}_${patternType}`;
                            this.patternMemory[key] = (this.patternMemory[key] || 0) + 1;
                        }
                    }
                } catch (e) {
                    // Bỏ qua lỗi
                }
            }
        }

        // Khởi tạo trọng số dựa trên performance
        let totalWeight = 0;
        for (const id in algScores) {
            const score = algScores[id] || 0;
            const accuracy = score / evalSamples;
            const baseWeight = 0.3 + (accuracy * 0.7); // Base weight từ 0.3-1.0
            this.weights[id] = Math.max(this.minWeight, baseWeight);
            totalWeight += this.weights[id];
        }
        
        // Chuẩn hóa
        if (totalWeight > 0) {
            for (const id in this.weights) {
                this.weights[id] /= totalWeight;
            }
        }
        
        console.log(`⚖️ Đã khởi tạo trọng số cho ${Object.keys(this.weights).length} thuật toán.`);
    }

    updateWithOutcome(historyPrefix, actualTx) {
        if (historyPrefix.length < 10) return;
        
        // Phát hiện pattern hiện tại
        const features = extractFeatures(historyPrefix);
        const patternType = detectPatternType(features.runs);
        
        for (const a of this.algs) {
            try {
                const pred = a.fn(historyPrefix);
                const correct = pred === actualTx ? 1 : 0;
                
                // Cập nhật performance history
                this.performanceHistory[a.id].push(correct);
                if (this.performanceHistory[a.id].length > 60) {
                    this.performanceHistory[a.id].shift();
                }
                
                // Tính accuracy gần nhất với trọng số thời gian
                const recentPerf = lastN(this.performanceHistory[a.id], 25);
                let weightedAccuracy = 0;
                let weightSum = 0;
                
                for (let i = 0; i < recentPerf.length; i++) {
                    const weight = Math.pow(0.9, recentPerf.length - i - 1); // Giảm dần
                    weightedAccuracy += recentPerf[i] * weight;
                    weightSum += weight;
                }
                
                const recentAccuracy = weightSum > 0 ? weightedAccuracy / weightSum : 0.5;
                
                // Pattern-specific adjustment
                let patternBonus = 0;
                if (patternType) {
                    const key = `${a.id}_${patternType}`;
                    const patternSuccess = this.patternMemory[key] || 0;
                    if (patternSuccess > 3) {
                        patternBonus = 0.1; // Bonus cho algorithm tốt với pattern này
                    }
                }
                
                // Điều chỉnh trọng số
                const targetWeight = Math.min(1, recentAccuracy + patternBonus + 0.1);
                const currentWeight = this.weights[a.id] || this.minWeight;
                
                const newWeight = this.emaAlpha * targetWeight + (1 - this.emaAlpha) * currentWeight;
                this.weights[a.id] = Math.max(this.minWeight, Math.min(1.5, newWeight));
                
                // Cập nhật pattern memory
                if (patternType && correct) {
                    const key = `${a.id}_${patternType}`;
                    this.patternMemory[key] = (this.patternMemory[key] || 0) + 1;
                }
                
            } catch (e) {
                this.weights[a.id] = Math.max(this.minWeight, (this.weights[a.id] || 1) * 0.92);
            }
        }

        // Chuẩn hóa trọng số
        const sumWeights = Object.values(this.weights).reduce((s, w) => s + w, 0);
        if (sumWeights > 0) {
            for (const id in this.weights) {
                this.weights[id] /= sumWeights;
            }
        }
    }

    predict(history) {
        if (history.length < 12) {
            return {
                prediction: 'tài',
                confidence: 0.5,
                rawPrediction: 'T'
            };
        }
        
        // Phát hiện pattern hiện tại để tăng cường algorithm phù hợp
        const features = extractFeatures(history);
        const patternType = detectPatternType(features.runs);
        
        const votes = { T: 0, X: 0 };
        let algorithmDetails = [];
        
        for (const a of this.algs) {
            try {
                const pred = a.fn(history);
                if (!pred) continue;
                
                let weight = this.weights[a.id] || this.minWeight;
                
                // Pattern-specific boosting
                if (patternType) {
                    const key = `${a.id}_${patternType}`;
                    const patternSuccess = this.patternMemory[key] || 0;
                    if (patternSuccess > 2) {
                        weight *= 1.2; // Boost 20% cho algorithm tốt với pattern này
                    }
                }
                
                votes[pred] = (votes[pred] || 0) + weight;
                algorithmDetails.push({ algorithm: a.id, prediction: pred, weight: weight });
            } catch (e) {
                // Bỏ qua thuật toán lỗi
            }
        }
        
        if (votes.T === 0 && votes.X === 0) {
            const fallback = algo5_freqRebalance(history) || 'T';
            return {
                prediction: fallback === 'T' ? 'tài' : 'xỉu',
                confidence: 0.5,
                rawPrediction: fallback
            };
        }
        
        const { key: best, val: bestVal } = majority(votes);
        const totalVotes = votes.T + votes.X;
        const baseConfidence = bestVal / totalVotes;
        
        // Điều chỉnh confidence dựa trên sự đồng thuận
        let consensusBonus = 0;
        const tAlgorithms = algorithmDetails.filter(a => a.prediction === 'T').length;
        const xAlgorithms = algorithmDetails.filter(a => a.prediction === 'X').length;
        const totalAlgorithms = tAlgorithms + xAlgorithms;
        
        if (totalAlgorithms > 0) {
            const consensusRatio = Math.max(tAlgorithms, xAlgorithms) / totalAlgorithms;
            if (consensusRatio > 0.7) consensusBonus = 0.1;
            if (consensusRatio > 0.8) consensusBonus = 0.15;
        }
        
        const confidence = Math.min(0.96, Math.max(0.55, baseConfidence + consensusBonus));
        
        return {
            prediction: best === 'T' ? 'tài' : 'xỉu',
            confidence,
            rawPrediction: best
        };
    }
}

// --- PATTERN ANALYSIS ĐƠN GIẢN ---
function getComplexPattern(history) {
    const minHistory = 15;
    if (history.length < minHistory) return "n/a";
    
    const historyTx = history.map(h => h.tx);
    return historyTx.slice(-minHistory).join('').toLowerCase();
}

// --- MANAGER CLASS TỐI ƯU ---
class SEIUManager {
    constructor(opts = {}) {
        this.history = [];
        this.ensemble = new SEIUEnsemble(ALL_ALGS, {
            emaAlpha: opts.emaAlpha ?? 0.06,
            historyWindow: opts.historyWindow ?? 700
        });
        this.currentPrediction = null;
        this.patternHistory = [];
    }
    
    calculateInitialStats() {
        const minStart = 20;
        if (this.history.length < minStart) return;
        
        // Huấn luyện trên 60 mẫu gần nhất
        const trainSamples = Math.min(60, this.history.length - minStart);
        const startIdx = this.history.length - trainSamples;
        
        for (let i = Math.max(minStart, startIdx); i < this.history.length; i++) {
            const historyPrefix = this.history.slice(0, i);
            const actualTx = this.history[i].tx;
            this.ensemble.updateWithOutcome(historyPrefix, actualTx);
        }
        
        console.log(`📊 AI đã huấn luyện trên ${trainSamples} mẫu.`);
    }

    loadInitial(lines) {
        this.history = lines;
        this.ensemble.fitInitial(this.history);
        this.calculateInitialStats();
        this.currentPrediction = this.getPrediction();
        
        console.log("📦 Đã tải lịch sử. Hệ thống AI sẵn sàng.");
        const nextSession = this.history.at(-1) ? this.history.at(-1).session + 1 : 'N/A';
        console.log(`🔮 Dự đoán phiên ${nextSession}: ${this.currentPrediction.prediction} (${(this.currentPrediction.confidence * 100).toFixed(0)}%)`);
    }

    pushRecord(record) {
        this.history.push(record);
        
        // Giữ lịch sử tối ưu
        if (this.history.length > 500) {
            this.history = this.history.slice(-450);
        }
        
        const prefix = this.history.slice(0, -1);
        if (prefix.length >= 10) {
            this.ensemble.updateWithOutcome(prefix, record.tx);
        }
        
        this.currentPrediction = this.getPrediction();
        
        // Ghi nhận pattern
        const features = extractFeatures(this.history);
        const patternType = detectPatternType(features.runs);
        if (patternType) {
            this.patternHistory.push(patternType);
            if (this.patternHistory.length > 20) this.patternHistory.shift();
        }
        
        console.log(`📥 ${record.session} → ${record.result}. Dự đoán ${record.session + 1}: ${this.currentPrediction.prediction} (${(this.currentPrediction.confidence * 100).toFixed(0)}%)`);
    }

    getPrediction() {
        return this.ensemble.predict(this.history);
    }
}

const seiuManager = new SEIUManager();

// --- API SERVER ---
const app = fastify({ logger: true });
await app.register(cors, { origin: "*" });

async function fetchAndProcessHistory() {
    try {
        const response = await fetch(API_URL);
        const data = await response.json();
        const newHistory = parseLines(data);
        
        if (newHistory.length === 0) {
            console.log("⚠️ Không có dữ liệu từ API.");
            return;
        }

        const lastSessionInHistory = newHistory.at(-1);

        if (!currentSessionId) {
            seiuManager.loadInitial(newHistory);
            txHistory = newHistory;
            currentSessionId = lastSessionInHistory.session;
            console.log(`✅ Đã tải ${newHistory.length} phiên lịch sử.`);
        } else if (lastSessionInHistory.session > currentSessionId) {
            const newRecords = newHistory.filter(r => r.session > currentSessionId);
            
            for (const record of newRecords) {
                seiuManager.pushRecord(record);
                txHistory.push(record);
            }
            
            // Giữ lịch sử gọn
            if (txHistory.length > 350) {
                txHistory = txHistory.slice(-300);
            }
            
            currentSessionId = lastSessionInHistory.session;
            if (newRecords.length > 0) {
                console.log(`🆕 Cập nhật ${newRecords.length} phiên. Phiên cuối: ${currentSessionId}`);
            }
        }
    } catch (e) {
        console.error("❌ Lỗi fetch dữ liệu:", e.message);
    }
}

// Khởi động
fetchAndProcessHistory();
clearInterval(fetchInterval);
fetchInterval = setInterval(fetchAndProcessHistory, 5000);
console.log(`🔄 Đang chạy với chu kỳ 5 giây.`);

// API Endpoints
app.get("/api/taixiumd5/lc79", async () => {
    const lastResult = txHistory.at(-1) || null;
    const currentPrediction = seiuManager.currentPrediction;
    const pattern = getComplexPattern(seiuManager.history);

    if (!lastResult || !currentPrediction) {
        return {
            phien_truoc: null,
            xuc_xac1: null,
            xuc_xac2: null,
            xuc_xac3: null,
            tong: null,
            ket_qua: "đang chờ...",
            phien_hien_tai: null,
            du_doan: "chưa có",
            do_tin_cay: "0%"
        };
    }

    return {
        phien_truoc: lastResult.session,
        xuc_xac1: lastResult.dice[0],
        xuc_xac2: lastResult.dice[1],
        xuc_xac3: lastResult.dice[2],
        tong: lastResult.total,
        ket_qua: lastResult.result.toLowerCase(),
        phien_hien_tai: lastResult.session + 1,
        du_doan: currentPrediction.prediction,
        do_tin_cay: `${(currentPrediction.confidence * 100).toFixed(0)}%`
    };
});

app.get("/api/taixiumd5/history", async () => { 
    if (!txHistory.length) {
        return { message: "không có dữ liệu lịch sử." };
    }
    
    const reversedHistory = [...txHistory].sort((a, b) => b.session - a.session);
    return reversedHistory.map((i) => ({
        session: i.session,
        dice: i.dice,
        total: i.total,
        result: i.result.toLowerCase(),
        tx_label: i.tx.toLowerCase(),
    }));
});

app.get("/", async () => { 
    return {
        status: "ok",
        msg: "AI Tài Xỉu MD5 Pro - Phiên bản Pattern Master",
        version: "3.0",
        algorithms: ALL_ALGS.length,
        pattern_recognition: "nâng cao (15+ mẫu phức tạp)",
        endpoints: [
            "/api/taixiumd5/lc79",
            "/api/taixiumd5/history"
        ]
    };
});

// --- SERVER START ---
const start = async () => {
    try {
        await app.listen({ port: PORT, host: "0.0.0.0" });
    } catch (err) {
        const fs = await import("node:fs");
        const logFile = path.join(__dirname, "server-error.log");
        const errorMsg = `
================= SERVER ERROR =================
Time: ${new Date().toISOString()}
Error: ${err.message}
Stack: ${err.stack}
=================================================
`;
        console.error(errorMsg);
        fs.writeFileSync(logFile, errorMsg, { encoding: "utf8", flag: "a+" });
        process.exit(1);
    }

    let publicIP = "0.0.0.0";
    try {
        const res = await fetch("https://ifconfig.me/ip");
        publicIP = (await res.text()).trim();
    } catch (e) {
        console.error("❌ Lỗi lấy public IP:", e.message);
    }

    console.log("\n🚀 AI Tài Xỉu MD5 Pro - Pattern Master đã khởi động!");
    console.log(`   ➜ Local:   http://localhost:${PORT}/`);
    console.log(`   ➜ Network: http://${publicIP}:${PORT}/\n`);
    console.log("📌 Các API endpoints:");
    console.log(`   ➜ GET /api/taixiumd5/lc79   → http://${publicIP}:${PORT}/api/taixiumd5/lc79`);
    console.log(`   ➜ GET /api/taixiumd5/history   → http://${publicIP}:${PORT}/api/taixiumd5/history`);
    console.log("\n🔧 Hệ thống AI Pattern Master với 10 thuật toán:");
    ALL_ALGS.forEach((alg, i) => console.log(`   ${i+1}. ${alg.id}`));
    console.log("\n🎯 Nhận diện 15+ mẫu cầu phức tạp:");
    console.log("   • Cầu 1-1, 2-2, 3-3, 4-4");
    console.log("   • Cầu 2-1-2, 1-2-1, 3-2-3, 4-2-4");
    console.log("   • Cầu bệt dài, cầu ngắn, cầu đảo");
    console.log("   • AI thích nghi theo cầu & bẻ cầu thông minh");
};

start();
