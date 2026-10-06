"""Explicit inputs, selection deduplication and private-output boundaries."""
import hashlib
import importlib.util
import json
from pathlib import Path
import sqlite3

import pytest

spec = importlib.util.spec_from_file_location('prepare_analysis', Path(__file__).parents[1]/'scripts/prepare-paper-analysis-run.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


@pytest.fixture
def inputs(tmp_path):
    library = tmp_path/'library'
    library.mkdir()
    db = sqlite3.connect(library/'catalog.sqlite3')
    db.execute('CREATE TABLE papers(id,metadata,pdf_path,created)')
    rows = []
    for index, content in enumerate([b'synthetic one', b'synthetic two', b'synthetic one']):
        path = library/f'{index}.pdf'
        path.write_bytes(content)
        db.execute('INSERT INTO papers VALUES(?,?,?,?)', (f'paper-{index}', '{}', path.name, index))
        rows.append({'references': [{'local_path': str(path)}], 'test_path': False,
                     'probe': {'page_count': 8, 'sha256': hashlib.sha256(content).hexdigest()},
                     'best_metadata': {'doi': f'10.0000/synthetic-{index}', 'title': 'Synthetic reading exercise',
                                       'basic_complete': True, 'origin': 'synthetic'}})
    db.commit(); db.close()
    audit = tmp_path/'audit.json'; audit.write_text(json.dumps({'rows': rows}))
    config = tmp_path/'model.json'; config.write_text('{}')
    return library, audit, config


def test_prepares_private_explicit_plan_and_deduplicates(inputs, tmp_path):
    library, audit, config = inputs
    out = tmp_path/'private-run'
    module.prepare(library, audit, out, [config], 2)
    plan = json.loads((out/'plan.json').read_text())
    selection = json.loads((out/'selection.json').read_text())
    assert plan['routes'][0]['ids'] == ['paper-0', 'paper-1']
    assert len({paper['sha256'] for paper in selection['papers']}) == 2
    assert plan['mode'] == 'full' and plan['notes'] and not plan['review']
    assert out.stat().st_mode & 0o777 == 0o700
    assert (out/'selection.json').stat().st_mode & 0o777 == 0o600
    with pytest.raises(ValueError, match='new private directory'):
        module.prepare(library, audit, out, [config], 2)


def test_changed_pdfs_and_missing_configs_do_not_produce_partial_plans(inputs, tmp_path):
    library, audit, config = inputs
    (library/'1.pdf').write_bytes(b'changed')
    with pytest.raises(ValueError, match='not enough unchanged'):
        module.prepare(library, audit, tmp_path/'absent', [config], 2)
    assert not (tmp_path/'absent').exists()
    with pytest.raises(ValueError, match='config is missing'):
        module.prepare(library, audit, tmp_path/'absent', [tmp_path/'missing'], 2)


def test_rejects_library_output_and_out_of_bound_selection(inputs, tmp_path):
    library, audit, config = inputs
    with pytest.raises(ValueError, match='new private directory'):
        module.prepare(library, audit, library/'outputs', [config], 2)
    with pytest.raises(ValueError, match='bounds'):
        module.prepare(library, audit, tmp_path/'absent', [config], 101)
