import torch
from ultralytics import YOLO

if __name__ == "__main__":
    # 1. 检查显卡 GPU 是否可用
    device = "0" if torch.cuda.is_available() else "cpu"
    print(f"Training on device: {device}")

    # 2. 加载你第一阶段跑出来的 best.pt 模型（增量微调/连续学习）
    model = YOLO(r"D:\ai\runs\detect\train\weights\best.pt")

    # 3. 开始训练融合后的全量数据集
    results = model.train(
        data="dataset/data.yaml",  # 配置文件路径
        epochs=50,                 # 再跑 50 轮
        imgsz=640,                 # 图像输入尺寸
        batch=16,                  # 每批次图像数量
        workers=8,                 # 数据加载线程数
        device=device,             # 指定 GPU 驱动训练
        name="train_v2"            # 新的保存文件夹名称，避免覆盖旧结果
    )

    print(
        "Training complete! Best weights saved at: runs/detect/train_v2/weights/best.pt"
    )