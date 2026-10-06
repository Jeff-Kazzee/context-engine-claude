import test from 'node:test';
import assert from 'node:assert/strict';
import { checkLegacyFrame, hasOnlyUnkeyedFrames, type ApiMessage } from '../context-engine/hooks/adapter.ts';

test('wave11: a foreign keyed frame without a current boundary refuses committed resume',()=>{
  const frame:ApiMessage={role:'user',content:[{type:'text',text:'<working_context file="/synthetic/context.md" delivery="replacement" frame="old-key">\nDELETED OLD BODY\n</working_context>'}]};
  for(const messages of [[frame],[{role:'user',content:[{type:'text',text:'NEW CONVERSATION'}]} as ApiMessage,frame]]){
    assert.equal(hasOnlyUnkeyedFrames(messages,'new-key'),true);assert.equal(checkLegacyFrame(messages,'new-key',1).kind,'refused');
    assert.equal(checkLegacyFrame(messages,'new-key',0).kind,'none');
  }
});
