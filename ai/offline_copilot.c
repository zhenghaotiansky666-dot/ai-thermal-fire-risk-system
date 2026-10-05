#include "offline_copilot.h"

double run_offline_ai(double* input) {
    // 特征映射关系:
    // input[0] -> smoke (烟雾浓度)
    // input[1] -> temp (环境温度)
    // input[2] -> rate (升温速率)
    // input[3] -> is_blocked (视觉受阻标志位)

    // 逻辑 1: 如果视觉判定通道受阻，直接返回 1.0 (BLOCK)
    if (input[3] > 0.5) {
        return 1.0;
    }
    
    // 逻辑 2: 温度超过 60℃ 或 烟雾超过 80，返回 1.0 (BLOCK)
    if (input[1] > 60.0 || input[0] > 80.0) {
        return 1.0;
    }

    // 逻辑 3: 其余正常安全情况，返回 0.0 (PASS)
    return 0.0;
}
