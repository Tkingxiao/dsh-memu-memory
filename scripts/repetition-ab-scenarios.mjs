// Handwritten synthetic holdouts. Labels are used only after generation.
import crypto from 'node:crypto'
import { loadDataset, validateDialogueShape } from './repetition-eval.mjs'

const additions = [
  ['station', 'zh-rp', '站台', '轻轻叹了口气', '许宁', '车票放在蓝色背包里',
    '继续站台场景，用两三句话回答：许宁的车票在哪里？',
    ['许宁'], ['车票', '蓝色', '背包']],
  ['tea', 'zh-rp', '茶室', '嘴角勾起一抹笑意', '苏禾', '茶叶放在第二层抽屉里',
    '继续茶室场景，苏禾找不到茶叶了，用两三句话告诉她位置。',
    ['苏禾'], ['茶叶', '第二层', '抽屉']],
  ['garden', 'zh-rp', '花园', '眼底闪过一丝复杂的神色', '陆遥', '温室钥匙挂在木门右侧',
    '陆遥要去温室。继续场景，说明钥匙位置，两三句话即可。',
    ['陆遥'], ['钥匙', '木门', '右侧']],
  ['ferry', 'zh-rp', '渡口', '他沉默了片刻', '乔川', '最后一班船在晚上九点离港',
    '乔川问最后一班船几点离港，继续场景并准确回答。',
    ['乔川'], ['九点', '离港']],
  ['names-long', 'names', '档案室', '她缓缓抬起了头', '诸葛明月', '档案装在灰色纸箱里',
    '诸葛明月问档案在哪里。明确写出她的全名和档案位置。',
    ['诸葛明月'], ['档案', '灰色', '纸箱']],
  ['names-two', 'names', '诊所', '像是终于松了口气', '欧阳若雪', '南宫清和负责取药',
    '欧阳若雪问谁负责取药。用完整姓名回答，不改变分工。',
    ['欧阳若雪', '南宫清和'], ['南宫清和', '取药']],
  ['quote-boundary', 'user-quote', '门口', '轻轻叹了口气', '林昭', '不要替我答应别人',
    '请明确写出林昭，并逐字引用我的边界“不要替我答应别人”，不要改写引文。',
    ['林昭', '不要替我答应别人'], ['不要替我答应别人']],
  ['quote-night', 'user-quote', '夜谈', '眼底闪过一丝复杂的神色', '沈青', '把窗留一条缝',
    '沈青问我刚才对窗户说了什么。请写出沈青并逐字引用“把窗留一条缝”。',
    ['沈青', '把窗留一条缝'], ['把窗留一条缝']],
  ['agreement-time', 'agreement', '日程', '这一点很重要', '程安', '每周三晚上八点一起复盘',
    '请写出程安并逐字复述约定“每周三晚上八点一起复盘”，不要变更时间。',
    ['程安', '每周三晚上八点一起复盘'], ['每周三', '八点', '复盘']],
  ['agreement-limit', 'agreement', '工作台', '我会先检查入口再检查边界', '顾辰', '绝不能对生产库直接执行迁移',
    '请写出顾辰，并逐字重复安全约束“绝不能对生产库直接执行迁移”。',
    ['顾辰', '绝不能对生产库直接执行迁移'], ['绝不能', '生产库', '迁移']],
  ['english-key', 'en', 'library', 'As you can see', 'Mara', 'The brass key is inside the green drawer',
    'In two sentences, name Mara and explain exactly where the brass key is.',
    ['Mara'], ['brass', 'key', 'green', 'drawer']],
  ['english-plan', 'en', 'meeting', 'A quiet sense of dread settled over the room', 'Evan', 'The review starts on Friday at nine',
    'Answer Evan in English: when does the review start? Keep the day and time.',
    ['Evan'], ['Friday', 'nine']],
  ['code-api', 'code', '代码评审', '这件事情需要格外注意', 'parseConfig', 'parseConfig 必须保留 ReadOnlyMap 返回类型',
    '解释 parseConfig 的返回类型，逐字保留 parseConfig 和 ReadOnlyMap，简短回答。',
    ['parseConfig', 'ReadOnlyMap'], ['parseConfig', 'ReadOnlyMap']],
  ['code-port', 'code', '配置审查', '我会先检查入口再检查边界', 'config.port', 'config.port 的默认值是 8080',
    'config.port 默认值是什么？给出精确标识符和数值，简短回答。',
    ['config.port', '8080'], ['config.port', '8080']],
]

export function loadAbDataset() {
  const base = loadDataset()
  const dialogues = [...base.dialogues]
  for (const [id, category, scene, filler, name, fact, request, necessary, requiredTerms] of additions) {
    const english = category === 'en'
    const target = english ? `${name}: ${fact}.` : `${name}：${fact}。`
    const dialogue = {
      schemaVersion: 1,
      kind: 'repetition-eval-dialogue',
      draft: true,
      notGold: true,
      window: 4,
      id: `ab-${id}`,
      pairId: `ab-${id}`,
      category,
      condition: 'baseline',
      description: 'Synthetic holdout: wording repetition versus required information.',
      turns: [
        { role: 'user', text: english ? `Scene: ${scene}. Remember this established fact: ${fact}.` : `场景是${scene}。已确认事实：${fact}。` },
        { role: 'assistant', text: english ? `${filler}. ${name} knows: ${fact}.` : `${name}${filler}，记得${fact}。` },
        { role: 'user', text: english ? 'Continue, preserving the established fact.' : '继续，不改变既定事实。' },
        { role: 'assistant', text: english ? `${filler}. ${name} confirms: ${fact}.` : `${name}${filler}，再次确认${fact}。` },
        { role: 'user', text: request },
        { role: 'assistant', text: target },
      ],
      labels: {
        necessaryPhrases: necessary.map(text => ({
          text,
          category: category === 'code' ? 'code-identifier' : category === 'agreement' ? 'agreement' : category === 'user-quote' ? 'user-quote' : 'name',
          turn: 5,
        })),
        facts: [{ id: `${id}-fact`, turn: 5, requiredTerms }],
      },
    }
    validateDialogueShape(dialogue, dialogue.id)
    dialogues.push(dialogue)
  }
  return {
    ...base,
    name: 'repetition-ab-20-synthetic-scenarios',
    sha256: crypto.createHash('sha256').update(JSON.stringify(dialogues)).digest('hex'),
    dialogues,
  }
}
