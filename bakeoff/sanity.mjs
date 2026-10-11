// Smoke check: does a candidate answer two short prompts coherently on this machine?
//   node sanity.mjs <hub id> <revision sha> <dtype>
// Used to tell "the model cannot do the task" apart from "the build does not run".
import * as tf from '@huggingface/transformers';
import { homedir } from 'node:os'; import { join } from 'node:path';
tf.env.cacheDir = join(homedir(), '.cache', 'agent-trace-clinic-bakeoff');
const [model, revision, dtype] = process.argv.slice(2);
const tok = await tf.AutoTokenizer.from_pretrained(model, { revision });
const lm = await tf.AutoModelForCausalLM.from_pretrained(model, { revision, dtype, device: 'cpu' });
for (const q of ['What is the capital of France? Answer in one sentence.', 'Return a JSON array of the first three prime numbers, nothing else.']) {
  const inputs = tok.apply_chat_template([{role:'system',content:'You are a helpful assistant. /no_think'},{role:'user',content:q}], { add_generation_prompt:true, return_dict:true, enable_thinking:false });
  const out = await lm.generate({ ...inputs, max_new_tokens: 60, do_sample: false });
  console.log(JSON.stringify(tok.batch_decode(out.slice(null,[inputs.input_ids.dims.at(-1),null]),{skip_special_tokens:true})[0]));
}
