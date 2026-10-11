"""Audit saved certification outputs without modifying the live run files."""
import hashlib,json,pathlib,sys,zipfile,xml.etree.ElementTree as E
root=pathlib.Path(sys.argv[1]).resolve()
suite=json.loads((root/'results.json').read_text())
rows=[]
for run in suite['results']:
    item={'id':run['id'],'state':run['terminalState'],'classification':run['classification'],
          'latencySec':run['latencySec'],'recoveries':run['telemetry']['modeMetrics']['recoveryCount'],
          'failedRequirements':[v for v in run['requirements'] if not v['passed']],
          'toolPath':run['toolPath'],'artifacts':[]}
    for artifact in run['artifacts']:
        file=root/run['id']/'data'/artifact['relativePath']
        digest=hashlib.sha256(file.read_bytes()).hexdigest()
        assert digest==artifact['sha256'],str(file)
        entry={'path':str(file),'sha256':digest,'metadataMatches':True}
        if file.suffix=='.docx':
            with zipfile.ZipFile(file) as doc:
                assert doc.testzip() is None
                xml=E.fromstring(doc.read('word/document.xml'))
                ns={'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
                entry['text']='\n'.join(''.join(n.itertext()) for n in xml.findall('.//w:t',ns))
                entry['tableCount']=len(xml.findall('.//w:tbl',ns))
        elif file.suffix in ('.py','.md','.txt'):
            entry['text']=file.read_text()
        item['artifacts'].append(entry)
    rows.append(item)
latencies=sorted(r['latencySec'] for r in rows)
summary={'cohort':str(root),'fullPasses':suite['fullPasses'],'byFamily':suite['byFamily'],
         'harnessFailures':suite['harnessFailures'],'p50Sec':latencies[4],'p95Sec':latencies[-1],
         'maximumRecoveries':max(r['recoveries'] for r in rows),'rows':rows}
print(json.dumps(summary,indent=2))
