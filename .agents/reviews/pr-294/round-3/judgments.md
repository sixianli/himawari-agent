# 第 3 轮判断
r1 成立（中高）：遮盖用了无词界子串，误遮 input_tokens、fencing_token、embedding_model；改成精确列名清单，并加保留这些列的测试，旧版本跑新测试失败。
r2 成立（低）：account_json、challenge_json 加入清单。
r3、r4、r5 可以更好，不改，等 Andy。推测项（sandbox 表的 plan_json 等是否含凭据）未核实，列给 Andy。
已连续三轮没过，第三轮的修改未再复核，停下报告。
