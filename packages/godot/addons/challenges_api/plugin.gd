@tool
extends EditorPlugin

## The client is a `class_name`, so it is available everywhere without an
## autoload. This plugin only exists so the addon can be enabled in the editor
## and shipped through the Asset Library.

func _enter_tree() -> void:
	pass


func _exit_tree() -> void:
	pass
