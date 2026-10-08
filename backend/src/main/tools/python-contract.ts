/** Run the saved source unchanged, checking supported return annotations on actual calls. */
export function buildPythonReturnValidationRunner(sourcePath: string): string {
  return `import ast, builtins, dis, inspect, pathlib, runpy, sys, types, typing
_target = str((pathlib.Path(__file__).parent / ${JSON.stringify(sourcePath)}).resolve())
_tree = ast.parse(pathlib.Path(_target).read_text(encoding="utf-8"))
# Only ordinary global functions with simple declarations are checked. Complex
# annotation expressions must not gain extra evaluation through instrumentation.
_declarations = {node.name: node.returns for node in _tree.body
    if isinstance(node, ast.FunctionDef) and node.returns is not None
    and not any(isinstance(item, ast.Call) for item in ast.walk(node.returns))}
_allowed = (dict, list, tuple, set, frozenset, str, bytes, bytearray, int, float, complex, bool, type(None))
_builtin_namespace = vars(builtins).copy()
_unsupported = object()
_errors = set()
def _annotation_node(node, namespace):
    if isinstance(node, ast.Constant):
        if node.value is None:
            return type(None)
        if isinstance(node.value, str):
            return _annotation_node(ast.parse(node.value, mode="eval").body, namespace)
    if isinstance(node, ast.Subscript):
        return _annotation_node(node.value, namespace)
    if isinstance(node, ast.Name):
        return namespace.get(node.id, _builtin_namespace.get(node.id, _unsupported))
    if isinstance(node, ast.Attribute):
        parent = _annotation_node(node.value, namespace)
        if isinstance(parent, types.ModuleType) and parent.__name__ in ("typing", "builtins"):
            return vars(parent).get(node.attr, _unsupported)
    return _unsupported
def _return_types(annotation, namespace):
    if isinstance(annotation, str):
        node = ast.parse(annotation, mode="eval").body
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.BitOr):
            left = _return_types(ast.unparse(node.left), namespace)
            right = _return_types(ast.unparse(node.right), namespace)
            return left + right if left is not None and right is not None else None
        annotation = _annotation_node(node, namespace)
    if annotation is None:
        annotation = type(None)
    origin = typing.get_origin(annotation)
    if origin in (typing.Union, types.UnionType):
        parts = [_return_types(item, namespace) for item in typing.get_args(annotation)]
        return tuple(kind for part in parts for kind in part) if all(part is not None for part in parts) else None
    kind = origin or annotation
    if kind not in _allowed:
        return None
    # Python's numeric type compatibility permits an int where float is declared.
    if kind is float:
        return (int, float)
    if kind is complex:
        return (int, float, complex)
    return (kind,)
def _observe_return(frame, event, value):
    if event != "return" or frame.f_code.co_filename != _target or frame.f_code.co_name not in _declarations:
        return
    function = frame.f_globals.get(frame.f_code.co_name)
    if not isinstance(function, types.FunctionType) or function.__code__ is not frame.f_code:
        return
    if function.__code__.co_flags & (inspect.CO_GENERATOR | inspect.CO_COROUTINE | inspect.CO_ASYNC_GENERATOR):
        return
    # A profiler also emits return(None) when an exception leaves the frame.
    # Only a normal return instruction can establish a returned-value contract.
    if dis.opname[frame.f_code.co_code[frame.f_lasti]] not in ("RETURN_VALUE", "RETURN_CONST"):
        return
    try:
        annotation = function.__annotations__.get("return", inspect.Signature.empty)
        expected = _return_types(annotation, function.__globals__)
        if expected is not None and not isinstance(value, expected):
            _errors.add(f"{function.__name__} returned {type(value).__name__}; declared return type requires {' or '.join(kind.__name__ for kind in expected)}")
    except Exception:
        # Unsupported forward references and custom types are outside this check.
        return
sys.argv[0] = _target
sys.path[0] = str(pathlib.Path(_target).parent)
_previous_profile = sys.getprofile()
sys.setprofile(_observe_return)
try:
    runpy.run_path(_target, run_name="__main__")
finally:
    sys.setprofile(_previous_profile)
if _errors:
    raise TypeError("Declared return contract failed: " + "; ".join(sorted(_errors)))
`;
}

/** Execute separate checks against the saved implementation and count real assertions. */
export function buildPythonBehaviorValidationRunner(sourcePath: string, validationCode: string): string {
  return `import ast, pathlib, runpy
_target = str((pathlib.Path(__file__).parent / ${JSON.stringify(sourcePath)}).resolve())
repaired = runpy.run_path(_target, run_name="workbench_validation")
_checks = ${JSON.stringify(validationCode)}
_count = 0
def _record_assertion():
    global _count
    _count += 1
def _assert_equal(actual, expected, message_factory):
    if not actual == expected:
        detail = "" if message_factory is None else "; message=" + repr(message_factory())
        raise AssertionError("Equality check failed; actual=" + repr(actual) + "; expected=" + repr(expected) + detail)
class _InstrumentAssertions(ast.NodeTransformer):
    def visit_Assert(self, node):
        self.generic_visit(node)
        check = node
        if isinstance(node.test, ast.Compare) and len(node.test.ops) == 1 and isinstance(node.test.ops[0], ast.Eq):
            message = ast.Constant(value=None) if node.msg is None else ast.Lambda(args=ast.arguments(posonlyargs=[], args=[], kwonlyargs=[], kw_defaults=[], defaults=[]), body=node.msg)
            check = ast.copy_location(ast.Expr(value=ast.Call(func=ast.Name(id="_workbench_assert_equal", ctx=ast.Load()), args=[node.test.left, node.test.comparators[0], message], keywords=[])), node)
        elif node.msg is None:
            node.msg = ast.Constant(value="Assertion failed: " + ast.unparse(node.test))
        return [ast.copy_location(ast.Expr(value=ast.Call(func=ast.Name(id="_workbench_record_assertion", ctx=ast.Load()), args=[], keywords=[])), node), check]
_tree = ast.fix_missing_locations(_InstrumentAssertions().visit(ast.parse(_checks, filename="<behavior_checks>")))
_namespace = {name: value for name, value in repaired.items() if not name.startswith("__")}
_namespace.update({"repaired": repaired, "__name__": "__main__", "__file__": __file__, "_workbench_record_assertion": _record_assertion, "_workbench_assert_equal": _assert_equal})
exec(compile(_tree, "<behavior_checks>", "exec"), _namespace)
if _count == 0:
    raise RuntimeError("No behavioral assertions were executed. Invoke the checks against the repaired implementation.")
print("WORKBENCH_ASSERTIONS_EXECUTED=" + str(_count))
`;
}
