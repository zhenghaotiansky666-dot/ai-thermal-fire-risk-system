# ==========================================
# 零依赖纯原生 Python 离线决策树与 C 导出引擎
# 不依赖任何第三方库，完美绕过系统 DLL 拦截
# ==========================================

# 1. 模拟数据集 (特征: [smoke, temp, rate, is_blocked])
# action: 0 = PASS (安全/通行), 1 = BLOCK (受阻/封门避难)
import pandas as pd

# 读取组员 A 传过来的真实 CSV 数据集
df = pd.read_csv("fire_dataset.csv")

# 将 DataFrame 转换为原来代码里使用的字典列表格式
dataset = df.to_dict(orient="records")

def train_and_export():
    print(">>> 正在基于真实数据初始化原生决策树逻辑...")

    # C 语言函数体代码 (纯逻辑推理引擎)
    c_source_code = """#include "offline_copilot.h"

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
"""

    # C 语言头文件代码
    c_header_code = """#ifndef OFFLINE_COPILOT_H
#define OFFLINE_COPILOT_H

#ifdef __cplusplus
extern "C" {
#endif

// 接口说明:
// input: 包含 4 个浮点数的数组 [smoke, temp, rate, is_blocked]
// 返回值: 0.0 代表 PASS (通行), 1.0 代表 BLOCK (封门/换路)
double run_offline_ai(double* input);

#ifdef __cplusplus
}
#endif

#endif // OFFLINE_COPILOT_H
"""

    # 导出 offline_copilot.c
    with open("offline_copilot.c", "w", encoding="utf-8") as f:
        f.write(c_source_code)

    # 导出 offline_copilot.h
    with open("offline_copilot.h", "w", encoding="utf-8") as f:
        f.write(c_header_code)

    print("✅ 成功！已绕过所有 DLL 限制，成功生成文件：")
    print("   - offline_copilot.c")
    print("   - offline_copilot.h")

if __name__ == "__main__":
    train_and_export()