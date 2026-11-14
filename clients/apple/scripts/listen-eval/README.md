# 收听评测

第 8 批“让它听”的四项评测：认人、口头指令、转文字、抢跑。认人和转文字都在 Mac 上用系统自带的本机转文字（SpeechAnalyzer）和 FluidAudio 声纹模型跑，不调对话模型，不花钱。

## 步骤

1. 手机上录音：打开“快捷指令”App，搜 Himawari 的 “Record listening samples”，照屏幕提示读完 398 句。录完在“文件”App 里把 “我的 iPhone → Himawari → listen-eval” 整个文件夹隔空投送到 Mac。
2. 下载公开语料（约 1.7 GB，跑完可以删）：`scripts/listen-eval/fetch-corpora.sh ~/listen-eval/corpora`。FLEURS（谷歌公开的多语种朗读语料，CC-BY 4.0）提供中日英的非主人声音和转文字样本；LibriSpeech（公开的英文有声书语料，CC-BY 4.0）提供标好说话人的英文样本，保证非主人至少有 10 个不同的人。
3. 合成旁人叫名字、电视里出现名字的声音（用 macOS 的 `say` 命令）：`swift run himawari-listen-eval synthesize --out ~/listen-eval/synthetic`。
4. 把三份材料合成一份评测清单，嘈杂样本在这一步混入人声背景：`swift run himawari-listen-eval prepare --phone ~/listen-eval/phone --corpora ~/listen-eval/corpora --synthetic ~/listen-eval/synthetic --out ~/listen-eval/run`。
5. 跑评测，结果一行一条写进 `observations.jsonl`，中断后再跑会接着跑：`swift run himawari-listen-eval run --clips ~/listen-eval/run`。
6. 把 `observations.jsonl` 交给云端线程，用服务器仓库里的 `node scripts/evals/listening-score.mjs` 出报告；口头指令的判定直接调用服务器自己的判定函数，结果和线上一致。

## 已知的近似

- 旁人在 AirPods 附近说话：用合成语音降低 20 dB（`--far-db`）近似，不是真的在耳机旁边放出来再录。
- 嘈杂样本：用三段英文朗读叠成的人声背景，按信噪比 5 dB（`--noise-snr`）混入，近似开着电视或在咖啡店。
