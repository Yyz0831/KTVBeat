"""Verify unseen English uses local LSTM G2P instead of a finite test word list."""
from pathlib import Path
import sys,dataclasses
APP=Path(__file__).resolve().parents[1];sys.path.insert(0,str(APP/'processing'))
from common import save,bounded_env
import os
os.environ.update(bounded_env())
import yaml,onnxruntime as ort
from g2pflow import G2PPipelineConfig,build_pipeline_from_config
calls=0;original=ort.InferenceSession
class Session:
    def __init__(self,*args,**kwargs):
        options=kwargs.get('sess_options') or ort.SessionOptions();options.intra_op_num_threads=4;options.inter_op_num_threads=1;kwargs['sess_options']=options
        self.session=original(*args,**kwargs)
    def __getattr__(self,name):return getattr(self.session,name)
    def run(self,*args,**kwargs):
        global calls
        calls+=1;return self.session.run(*args,**kwargs)
ort.InferenceSession=Session
root=APP/'models/tifa';text='quasistarlight'
for p in [root/'evaluation-english.txt',root/'dictionaries/ds_cmudict-07b.txt']:
    assert text not in {line.split()[0].lower() for line in p.read_text().splitlines() if line.strip()}
config=G2PPipelineConfig.model_validate(yaml.safe_load((root/'g2p-zh-en.yaml').read_text()))
pipeline=build_pipeline_from_config(config,root_path=root)
words=pipeline.convert(text,languages=['en'])
assert len(words)==1 and words[0].readings and calls>0
save(APP/'records/english-g2p.json',dict(word=text,not_in_dictionaries=True,onnx_inference_calls=calls,words=[dataclasses.asdict(w) for w in words],passed=True))
print('Unseen English G2P passed:',text,'ONNX calls:',calls)
